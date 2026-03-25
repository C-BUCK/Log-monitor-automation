// src/pipeline/runner.ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type {
  ClassifiedError,
  Priority,
  PipelineJob,
  RunSummary,
} from "../types.js";
import type { ErrorEntry } from "../state/types.js";
import { StateManager } from "../state/manager.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { git, resetToLatest, pruneLocalBranches } from "../utils/git.js";
import { logger } from "../utils/logger.js";
import { BetterStackClient } from "../integrations/betterstack.js";
import { ClaudeClient } from "../integrations/claude.js";
import { JiraClient } from "../integrations/jira.js";
import { GitHubClient } from "../integrations/github.js";
import { SlackClient } from "../integrations/slack.js";
import { scan } from "./scanner.js";
import { loadRules, classify, classifyAllAsync } from "./classifier.js";
import { deduplicate } from "./dedup.js";
import { analyze, buildDefaultAnalysis } from "./analyzer.js";
import { createTicket } from "./ticketer.js";
import { fix } from "./fixer.js";
import { monitorCi, type CiMonitorResult } from "./ci-monitor.js";
import { notify } from "./notifier.js";
import { groupByRootCause } from "./grouper.js";

const PRIORITY_RANK: Record<Priority, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Skip: 4,
};

const MAX_FAILURE_COUNT = 3;
const FIX_RETRY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours between fix retries

function stateKeyForError(err: ClassifiedError): string {
  return `${err.service}:${err.environment}:${err.pattern}`;
}

function reconstructClassifiedError(
  key: string,
  entry: ErrorEntry,
): ClassifiedError {
  const parts = key.split(":");
  // key format: service:environment:pattern (pattern may contain colons)
  const service = parts[0] ?? "unknown";
  const environment = parts[1] ?? "unknown";
  const pattern = parts.slice(2).join(":");
  return {
    pattern,
    service,
    environment,
    githubRepo: "",
    occurrenceCount: entry.count,
    exampleMessage: pattern,
    level: "error",
    component: null,
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    rawSamples: [],
    priority: entry.priority as Priority,
    prioritySource: entry.prioritySource as "rule" | "frequency" | "haiku",
  };
}

function isTimedOut(runStart: number, timeoutMinutes: number): boolean {
  return Date.now() - runStart > timeoutMinutes * 60 * 1000;
}

export async function runPipeline(config: AppConfig): Promise<RunSummary> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const runStart = Date.now();
  const failedSteps: string[] = [];
  const jobs: PipelineJob[] = [];
  let runStatus: "completed" | "failed" = "completed";
  let errorsScanned = 0;
  let newErrorCount = 0;
  let deduplicatedCount = 0;
  let deferredCount = 0;
  let prsOpened = 0;
  let groupsFormed = 0;
  let followersSkipped = 0;

  const stateManager = new StateManager(config.stateDir);

  // Step 1: Acquire lock
  const lock = acquireLock(config.stateDir, config.pipeline.runTimeoutMinutes);
  if (!lock.acquired) {
    logger.warn("Could not acquire lock, aborting run", { reason: lock.reason });
    return {
      id: runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "failed",
      errorsScanned: 0,
      newErrors: 0,
      deduplicatedErrors: 0,
      deferredErrors: 0,
      prsOpened: 0,
      ciPassed: 0,
      ciFailed: 0,
      costEstimateUsd: 0,
      failedSteps: ["lock-acquisition"],
      jobs: [],
    };
  }

  // Initialize clients (pass dryRun to skip external calls)
  const betterstack = new BetterStackClient(
    config.betterstack.apiToken,
    config.dryRun,
  );
  const claudeClient = new ClaudeClient(
    config.anthropic.apiKey,
    config.dryRun,
  );
  const jiraClient = new JiraClient(
    config.jira.baseUrl,
    config.jira.email,
    config.jira.apiToken,
    config.dryRun,
  );
  const githubClient = new GitHubClient(
    config.github.accessToken,
    config.dryRun,
  );
  const slackClient = new SlackClient(
    config.slack.botToken,
    config.slack.channelId,
    config.slack.webhookUrl,
    config.dryRun,
  );

  let ciPassed = 0;
  let ciFailed = 0;
  let ciResult: CiMonitorResult | null = null;
  let staleReminders: Array<{
    key: string;
    jiraTicket: string;
    jiraUrl?: string;
    daysSinceCreated: number;
  }> = [];

  try {
    logger.info("Pipeline run started", { runId, dryRun: config.dryRun });

    // Step 2b: Configure git identity and HTTPS auth for commits/pushes
    git(".", ["config", "--global", "user.email", "automation@example.com"]);
    git(".", ["config", "--global", "user.name", "Log Monitor Automation"]);
    git(".", ["config", "--global", "credential.helper", "store"]);
    git(".", [
      "config",
      "--global",
      `url.https://x-access-token:${config.github.accessToken}@github.com/.insteadOf`,
      "https://github.com/",
    ]);

    // Step 3: Prune stale state and run history
    stateManager.pruneErrors(config.pipeline.statePruneAgeDays);
    stateManager.pruneRuns(config.pipeline.runHistoryRetentionDays);

    // Step 4: Pull repos (clone-if-missing, then reset + prune)
    for (const service of config.services) {
      const repoPath = service.repoLocalPath;
      if (!fs.existsSync(repoPath)) {
        logger.info("Cloning repo", {
          repo: service.githubRepo,
          path: repoPath,
        });
        git(".", [
          "clone",
          `https://github.com/${service.githubRepo}.git`,
          repoPath,
        ]);
      }
      // Fetch all branches, start on analysisBranch (main) for scanning/analysis
      resetToLatest(repoPath, config.pipeline.analysisBranch);
      pruneLocalBranches(repoPath, "fix/");
    }

    // Step 5: Check for deferred errors from previous runs
    // Only include deferred errors that DON'T already have tickets — ticketed
    // errors are handled by the fix-retry path (Step 8a.5) with cooldown.
    const errorState = stateManager.loadErrors();
    const deferredErrors: ClassifiedError[] = [];
    for (const [key, entry] of Object.entries(errorState.patterns)) {
      if (entry.status === "deferred" && !entry.jiraTicket) {
        const serviceName = key.split(":")[0];
        const service = config.services.find((s) => s.name === serviceName);
        const reconstructed = reconstructClassifiedError(key, entry);
        if (service) {
          reconstructed.githubRepo = service.githubRepo;
        }
        deferredErrors.push(reconstructed);
      }
    }
    if (deferredErrors.length > 0) {
      logger.info("Loaded deferred errors from previous runs", {
        count: deferredErrors.length,
      });
    }

    // Step 6a: Scan (with one retry on failure)
    let scannedErrors;
    try {
      scannedErrors = await scan(betterstack, config.services);
    } catch (scanErr) {
      logger.warn("Scan failed, retrying once", { error: String(scanErr) });
      try {
        scannedErrors = await scan(betterstack, config.services);
      } catch (retryErr) {
        logger.error("Scan failed on retry, aborting run", {
          error: String(retryErr),
        });
        failedSteps.push("scan");
        runStatus = "failed";
        throw retryErr;
      }
    }
    errorsScanned = scannedErrors.length;

    // Step 6b: Deduplicate BEFORE classification (avoids wasting Haiku tokens on known errors)
    const { newErrors: newScanned, duplicates } = await deduplicate(
      scannedErrors,
      stateManager,
      jiraClient,
    );
    deduplicatedCount = duplicates.length;

    // Step 6c: Classify only NEW errors (not already in state)
    const rulesPath = path.resolve("classification-rules.json");
    const rules = loadRules(rulesPath);
    const classified = await classifyAllAsync(
      newScanned,
      rules,
      claudeClient,
    );

    // I14: Re-classify deferred errors with current rules (priority may have changed)
    const reclassifiedDeferred = deferredErrors.map((e) => classify(e, rules));
    const newErrors = [...classified, ...reclassifiedDeferred];

    // Step 6d: Sort by priority rank then occurrence count, select top N
    const sorted = newErrors.sort((a, b) => {
      const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (rankDiff !== 0) return rankDiff;
      return b.occurrenceCount - a.occurrenceCount;
    });

    const maxErrors = config.pipeline.maxErrorsPerRun;
    const selected = sorted.slice(0, maxErrors);
    const remainder = sorted.slice(maxErrors);
    newErrorCount = selected.length;

    // Step 7: Mark remainder as deferred in state
    if (remainder.length > 0) {
      const state = stateManager.loadErrors();
      for (const err of remainder) {
        const key = stateKeyForError(err);
        if (state.patterns[key]) {
          state.patterns[key].status = "deferred";
        } else {
          state.patterns[key] = {
            status: "deferred",
            firstSeen: err.firstSeen,
            lastSeen: err.lastSeen,
            count: err.occurrenceCount,
            priority: err.priority,
            prioritySource: err.prioritySource,
            ciAttempts: 0,
            failureCount: 0,
            slackNotified: false,
          };
        }
      }
      stateManager.saveErrors(state);
      deferredCount = remainder.length;
      logger.info("Deferred excess errors", { deferredCount });
    }

    // Step 8a: Analyze + create tickets for all selected errors (fast batch)
    const jobMap = new Map<string, PipelineJob>();
    for (const error of selected) {
      const key = stateKeyForError(error);
      const job: PipelineJob = { error, outcome: "skipped" };
      jobMap.set(key, job);
      jobs.push(job);

      try {
        // Check if this error already has a ticket — skip re-analysis
        const state = stateManager.loadErrors();
        const existing = state.patterns[key];
        if (existing?.jiraTicket) {
          logger.info("Skipping analysis — ticket already exists", { key, jiraTicket: existing.jiraTicket });
          job.jiraTicket = existing.jiraTicket;
          job.jiraUrl = existing.jiraUrl;
          job.ticketCreated = false;
          // Load persisted analysis so grouper can use it
          if (existing.analysis) {
            job.analysis = existing.analysis;
          }
          continue;
        }

        // Check failure count — abandon after MAX_FAILURE_COUNT
        if (existing && existing.failureCount >= MAX_FAILURE_COUNT) {
          logger.warn("Error abandoned after max failures", { key, failureCount: existing.failureCount });
          existing.status = "abandoned";
          stateManager.saveErrors(state);
          job.outcome = "failed";
          job.failureReason = `Abandoned after ${MAX_FAILURE_COUNT} failures`;
          continue;
        }

        // Find the service for this error
        const service = config.services.find((s) => s.githubRepo === error.githubRepo);
        if (!service) {
          logger.warn("No service config for error", { githubRepo: error.githubRepo });
          job.outcome = "failed";
          job.failureReason = `No service config for repo ${error.githubRepo}`;
          continue;
        }

        // Analyze
        logger.info("Starting analysis", { key, pattern: error.pattern, priority: error.priority, repo: service.repoLocalPath });
        const analysis = await analyze(error, service.repoLocalPath, claudeClient);
        job.analysis = analysis;

        // I1: Persist analysis immediately so it's not lost if createTicket throws
        {
          const stateForAnalysis = stateManager.loadErrors();
          if (!stateForAnalysis.patterns[key]) {
            stateForAnalysis.patterns[key] = {
              status: "active",
              firstSeen: error.firstSeen,
              lastSeen: error.lastSeen,
              count: error.occurrenceCount,
              priority: error.priority,
              prioritySource: error.prioritySource,
              ciAttempts: 0,
              failureCount: 0,
              slackNotified: false,
            };
          }
          stateForAnalysis.patterns[key].analysis = analysis;
          stateManager.saveErrors(stateForAnalysis);
        }

        // Create ticket — include BetterStack source ID for logs link and example message for readable title
        const envSource = service.betterstackSources[error.environment as keyof typeof service.betterstackSources];
        const ticket = await createTicket(analysis, error.priority, service.jiraProjectKey, jiraClient, envSource?.sourceId, error.exampleMessage);
        job.jiraTicket = ticket.key;
        job.jiraUrl = ticket.url;
        job.ticketCreated = ticket.created;

        // Update state with ticket info
        const updatedState = stateManager.loadErrors();
        if (!updatedState.patterns[key]) {
          updatedState.patterns[key] = {
            status: "active",
            firstSeen: error.firstSeen,
            lastSeen: error.lastSeen,
            count: error.occurrenceCount,
            priority: error.priority,
            prioritySource: error.prioritySource,
            ciAttempts: 0,
            failureCount: 0,
            slackNotified: false,
          };
        }
        updatedState.patterns[key].jiraTicket = ticket.key;
        if (ticket.url) {
          updatedState.patterns[key].jiraUrl = ticket.url;
        }
        updatedState.patterns[key].analysis = analysis;
        stateManager.saveErrors(updatedState);
      } catch (err) {
        logger.error("Analyze/ticket failed", { pattern: error.pattern, error: String(err) });
        job.outcome = "failed";
        job.failureReason = String(err);

        const state = stateManager.loadErrors();
        if (state.patterns[key]) {
          state.patterns[key].failureCount++;
          state.patterns[key].lastAttempt = new Date().toISOString();
        } else {
          state.patterns[key] = {
            status: "active",
            firstSeen: error.firstSeen,
            lastSeen: error.lastSeen,
            count: error.occurrenceCount,
            priority: error.priority,
            prioritySource: error.prioritySource,
            ciAttempts: 0,
            failureCount: 1,
            lastAttempt: new Date().toISOString(),
            slackNotified: false,
          };
        }
        stateManager.saveErrors(state);
        failedSteps.push(`ticket:${error.pattern}`);
      }
    }

    // Step 8a.5: Pick up previously ticketed errors that never got a fix PR
    // I2: Reload state fresh each iteration to avoid clobbering Step 8a writes
    const retryKeys = Object.keys(stateManager.loadErrors().patterns);
    for (const key of retryKeys) {
      const freshState = stateManager.loadErrors();
      const entry = freshState.patterns[key];
      if (!entry) continue;

      // Skip if still within cooldown period from last attempt
      const msSinceLastAttempt = entry.lastAttempt
        ? Date.now() - new Date(entry.lastAttempt).getTime()
        : Infinity;

      if (
        entry.jiraTicket &&
        !entry.prUrl &&
        entry.status !== "abandoned" &&
        entry.status !== "resolved" &&
        entry.failureCount < MAX_FAILURE_COUNT &&
        entry.ciStatus !== "needs-human" &&
        !jobMap.has(key)
      ) {
        // Enforce cooldown between retry attempts
        if (msSinceLastAttempt < FIX_RETRY_COOLDOWN_MS) {
          const minutesLeft = Math.round((FIX_RETRY_COOLDOWN_MS - msSinceLastAttempt) / 60_000);
          logger.info("Skipping fix retry (cooldown)", {
            key,
            jiraTicket: entry.jiraTicket,
            minutesUntilRetry: minutesLeft,
          });
          continue;
        }

        const serviceName = key.split(":")[0];
        const service = config.services.find((s) => s.name === serviceName);
        if (!service) continue;

        const reconstructed = reconstructClassifiedError(key, entry);
        reconstructed.githubRepo = service.githubRepo;

        logger.info("Retrying fix for ticketed error without PR", {
          key,
          jiraTicket: entry.jiraTicket,
          hasPersistedAnalysis: !!entry.analysis,
        });

        // Use persisted analysis if available, otherwise re-analyze
        try {
          const analysis = entry.analysis
            ?? await analyze(reconstructed, service.repoLocalPath, claudeClient);
          // Persist analysis so future retries skip re-analysis
          if (!entry.analysis) {
            const stateToSave = stateManager.loadErrors();
            if (stateToSave.patterns[key]) {
              stateToSave.patterns[key].analysis = analysis;
              stateManager.saveErrors(stateToSave);
            }
          }
          const job: PipelineJob = {
            error: reconstructed,
            analysis,
            jiraTicket: entry.jiraTicket,
            jiraUrl: entry.jiraUrl,
            outcome: "skipped",
          };
          jobMap.set(key, job);
          jobs.push(job);
        } catch (err) {
          logger.warn("Re-analysis failed for ticketed error", { key, error: String(err) });
          const stateToSave = stateManager.loadErrors();
          if (stateToSave.patterns[key]) {
            stateToSave.patterns[key].failureCount++;
            stateManager.saveErrors(stateToSave);
          }
        }
      }
    }

    // Step 8a.6: Semantic grouping — group analyzed jobs by root cause
    const followerKeys = new Set<string>();
    let groupResult: Awaited<ReturnType<typeof groupByRootCause>> | null = null;

    try {
      const jobsWithAnalysis = [...jobMap.entries()]
        .filter(([, j]) => j.analysis)
        .map(([, j]) => j);

      if (jobsWithAnalysis.length >= 2) {
        groupResult = await groupByRootCause(jobsWithAnalysis, claudeClient);
        groupsFormed = groupResult.groups.length;

        for (const group of groupResult.groups) {
          const leadKey = stateKeyForError(group.lead.error);
          for (const follower of group.followers) {
            const fKey = stateKeyForError(follower.error);
            followerKeys.add(fKey);
            followersSkipped++;

            // Mark follower in state
            const state = stateManager.loadErrors();
            if (state.patterns[fKey]) {
              state.patterns[fKey].groupLeadKey = leadKey;
              stateManager.saveErrors(state);
            }
          }

          // Add Jira comment to lead ticket listing all grouped patterns
          const leadJob = jobMap.get(leadKey);
          if (leadJob?.jiraTicket && group.followers.length > 0) {
            const allPatterns = [group.lead, ...group.followers];
            const totalOccurrences = allPatterns.reduce((sum, j) => sum + j.error.occurrenceCount, 0);
            const comment = [
              `This ticket covers ${allPatterns.length} related error patterns that share the same root cause:`,
              ...allPatterns.map((j, i) => `${i + 1}. "${j.error.pattern}" (${j.error.occurrenceCount} occurrences)`),
              `Total occurrences: ${totalOccurrences}`,
            ].join("\n");
            try {
              await jiraClient.addComment(leadJob.jiraTicket, comment);
            } catch (err) { logger.warn("Failed to add grouping comment to Jira", { ticket: leadJob.jiraTicket, error: String(err) }); }
          }
        }

        logger.info("Semantic grouping complete", { groupsFormed, followersSkipped });
      }
    } catch (err) {
      logger.error("Semantic grouping failed, continuing without groups", { error: String(err) });
    }

    // Step 8b: Generate fixes sequentially for jobs that have tickets (Critical → Low)
    const fixQueue = [...jobMap.entries()]
      .filter(([key, job]) => job.analysis && job.jiraTicket && !followerKeys.has(key))
      .sort(([, a], [, b]) => PRIORITY_RANK[a.error.priority] - PRIORITY_RANK[b.error.priority]);
    for (const [key, job] of fixQueue) {

      if (isTimedOut(runStart, config.pipeline.runTimeoutMinutes)) {
        logger.warn("Run timeout reached, skipping remaining fixes");
        break;
      }

      const service = config.services.find((s) => s.githubRepo === job.error.githubRepo);
      if (!service) continue;

      // Record attempt timestamp before trying
      {
        const state = stateManager.loadErrors();
        if (state.patterns[key]) {
          state.patterns[key].lastAttempt = new Date().toISOString();
          stateManager.saveErrors(state);
        }
      }

      try {
        const fixResult = await fix(
          job.analysis!,
          job.error.priority,
          job.jiraTicket!,
          job.jiraUrl || "",
          service.repoLocalPath,
          config.pipeline.targetBranch,
          githubClient,
          claudeClient,
          jiraClient,
        );

        job.branch = fixResult.branch;
        job.prUrl = fixResult.prUrl;
        job.prNumber = fixResult.prNumber;
        job.outcome = fixResult.outcome;
        job.failureReason = fixResult.failureReason;

        if (fixResult.outcome === "success" && fixResult.prUrl) {
          prsOpened++;

          // Propagate ticket/PR info to followers
          if (groupResult) {
            const leadGroup = groupResult.groups.find(
              (g) => stateKeyForError(g.lead.error) === key
            );
            if (leadGroup) {
              const state = stateManager.loadErrors();
              for (const follower of leadGroup.followers) {
                const fKey = stateKeyForError(follower.error);
                if (state.patterns[fKey]) {
                  state.patterns[fKey].jiraTicket = job.jiraTicket;
                  state.patterns[fKey].jiraUrl = job.jiraUrl;
                  state.patterns[fKey].prUrl = fixResult.prUrl;
                  state.patterns[fKey].prNumber = fixResult.prNumber;
                  state.patterns[fKey].branch = fixResult.branch;
                }
              }
              stateManager.saveErrors(state);
            }
          }
        }

        // Update state with fix info
        const state = stateManager.loadErrors();
        const entry = state.patterns[key];
        if (entry) {
          entry.status = "active";
          entry.branch = fixResult.branch;
          entry.prUrl = fixResult.prUrl;
          entry.prNumber = fixResult.prNumber;
          if (fixResult.outcome === "success") {
            entry.prStatus = "open";
            entry.ciStatus = "pending";
            entry.ciAttempts = 0; // C4: Reset for new PR
          } else if (fixResult.outcome === "already-fixed") {
            entry.status = "resolved";
            entry.prStatus = "not-needed";
            // Comment on Jira ticket so humans know no PR is expected
            if (entry.jiraTicket) {
              try {
                await jiraClient.addComment(
                  entry.jiraTicket,
                  `Automated fix skipped — the bug appears to be already resolved on the ${config.pipeline.targetBranch} branch. No PR needed. Will re-open if the error recurs.`
                );
              } catch (err) { logger.warn("Failed to add already-fixed comment to Jira", { ticket: entry.jiraTicket, error: String(err) }); }
            }
          } else if (fixResult.outcome === "needs-human") {
            entry.ciStatus = "needs-human";
          } else if (fixResult.outcome === "failed") {
            // C5: Non-throwing failure — still increment failureCount
            entry.failureCount++;
            entry.lastAttempt = new Date().toISOString();
            if (entry.failureCount >= MAX_FAILURE_COUNT) {
              entry.status = "abandoned";
            }
          }
          stateManager.saveErrors(state);
        }
      } catch (err) {
        logger.error("Fix failed", { pattern: job.error.pattern, error: String(err) });
        job.outcome = "failed";
        job.failureReason = String(err);

        const state = stateManager.loadErrors();
        if (state.patterns[key]) {
          state.patterns[key].failureCount++;
          state.patterns[key].lastAttempt = new Date().toISOString();
          if (state.patterns[key].failureCount >= MAX_FAILURE_COUNT) {
            state.patterns[key].status = "abandoned";
          }
        }
        stateManager.saveErrors(state);
        failedSteps.push(`fix:${job.error.pattern}`);
      }
    }

    // Step 9: CI Monitor all open PRs
    try {
      ciResult = await monitorCi(
        stateManager,
        githubClient,
        claudeClient,
        jiraClient,
        config,
      );
      ciPassed = ciResult.passed.length;
      ciFailed = ciResult.failed.length;
      staleReminders = ciResult.staleReminders;
    } catch (err) {
      logger.error("CI monitoring failed", { error: String(err) });
      failedSteps.push("ci-monitor");
    }

    // I16: Mark as failed if any steps failed
    if (failedSteps.length > 0) {
      runStatus = "failed";
    }

    // Step 10: Build summary and notify
    const costEstimateUsd = claudeClient.getTotalCost();
    const summary: RunSummary = {
      id: runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: runStatus,
      errorsScanned,
      newErrors: newErrorCount,
      deduplicatedErrors: deduplicatedCount,
      deferredErrors: deferredCount,
      prsOpened,
      ciPassed,
      ciFailed,
      costEstimateUsd,
      failedSteps,
      jobs,
      groupsFormed,
      followersSkipped,
      ciFixesAttempted: ciResult?.ciFixesAttempted ?? 0,
      ciFixesPushed: ciResult?.ciFixesPushed ?? 0,
    };

    try {
      const consecutiveFailures = stateManager.getConsecutiveFailures();
      await notify(
        summary,
        staleReminders,
        consecutiveFailures,
        config.pipeline.costAlertThresholdUsd,
        slackClient,
      );
    } catch (err) {
      logger.error("Slack notification failed", { error: String(err) });
      failedSteps.push("notify");
    }

    // Step 11: Save run to audit log
    stateManager.appendRun({
      id: runId,
      startedAt,
      completedAt: summary.completedAt,
      status: runStatus,
      errorsScanned,
      newErrors: newErrorCount,
      deduplicatedErrors: deduplicatedCount,
      deferredErrors: deferredCount,
      prsOpened,
      ciPassed,
      ciFailed,
      costEstimateUsd,
      failedSteps,
      groupsFormed,
      followersSkipped,
      ciFixesAttempted: ciResult?.ciFixesAttempted ?? 0,
      ciFixesPushed: ciResult?.ciFixesPushed ?? 0,
    });

    logger.info("Pipeline run completed", {
      runId,
      status: runStatus,
      errorsScanned,
      newErrors: newErrorCount,
      prsOpened,
      ciPassed,
      ciFailed,
      deferredErrors: deferredCount,
      costEstimateUsd,
    });

    return summary;
  } catch (err) {
    runStatus = "failed";
    logger.error("Pipeline run failed", { runId, error: String(err) });

    const costEstimateUsd = claudeClient.getTotalCost();
    const summary: RunSummary = {
      id: runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: "failed",
      errorsScanned,
      newErrors: newErrorCount,
      deduplicatedErrors: deduplicatedCount,
      deferredErrors: deferredCount,
      prsOpened,
      ciPassed,
      ciFailed,
      costEstimateUsd,
      failedSteps,
      jobs,
      groupsFormed,
      followersSkipped,
      ciFixesAttempted: ciResult?.ciFixesAttempted ?? 0,
      ciFixesPushed: ciResult?.ciFixesPushed ?? 0,
    };

    // Try to save run even on failure
    try {
      stateManager.appendRun({
        id: runId,
        startedAt,
        completedAt: summary.completedAt,
        status: "failed",
        errorsScanned,
        newErrors: newErrorCount,
        deduplicatedErrors: deduplicatedCount,
        deferredErrors: deferredCount,
        prsOpened,
        ciPassed,
        ciFailed,
        costEstimateUsd,
        failedSteps,
        groupsFormed: 0,
        followersSkipped: 0,
        ciFixesAttempted: ciResult?.ciFixesAttempted ?? 0,
        ciFixesPushed: ciResult?.ciFixesPushed ?? 0,
      });
    } catch {
      logger.error("Failed to save run entry after pipeline failure");
    }

    return summary;
  } finally {
    // Step 12: Release lock
    releaseLock(config.stateDir);
  }
}
