// src/pipeline/ci-monitor.ts
import type { StateManager } from "../state/manager.js";
import type { GitHubClient } from "../integrations/github.js";
import type { ClaudeClient } from "../integrations/claude.js";
import type { JiraClient } from "../integrations/jira.js";
import type { AppConfig } from "../config.js";
import { fixCiFailure } from "./ci-fixer.js";
import { logger } from "../utils/logger.js";

export interface CiMonitorResult {
  passed: string[];    // pattern keys
  failed: string[];    // pattern keys
  pending: string[];   // pattern keys
  needsHuman: string[];  // newly marked needs-human
  staleReminders: Array<{ key: string; jiraTicket: string; daysSinceCreated: number }>;
  ciFixesAttempted: number;
  ciFixesPushed: number;
}

async function transitionTicketToDone(entry: { jiraTicket?: string }, jiraClient: JiraClient): Promise<void> {
  if (!entry.jiraTicket) return;
  try {
    await jiraClient.transitionTo(entry.jiraTicket, "Done");
  } catch (err) {
    logger.warn("Failed to transition Jira ticket to Done", { jiraTicket: entry.jiraTicket, error: String(err) });
  }
}

export async function monitorCi(
  stateManager: StateManager,
  githubClient: GitHubClient,
  claudeClient: ClaudeClient,
  jiraClient: JiraClient,
  config: AppConfig
): Promise<CiMonitorResult> {
  const state = stateManager.loadErrors();
  const result: CiMonitorResult = {
    passed: [],
    failed: [],
    pending: [],
    needsHuman: [],
    staleReminders: [],
    ciFixesAttempted: 0,
    ciFixesPushed: 0,
  };

  // Handle fix-pushed entries (cross-run fallback)
  const fixPushedEntries = Object.entries(state.patterns).filter(
    ([, entry]) =>
      entry.prStatus === "open" &&
      entry.ciStatus === "fix-pushed" &&
      entry.branch &&
      entry.prNumber
  );

  for (const [key, entry] of fixPushedEntries) {
    const [owner, repo] = getOwnerRepo(key, config);
    if (!owner || !repo || !entry.prNumber) continue;

    try {
      const ciStatus = await githubClient.getPrChecks(owner, repo, entry.prNumber);
      if (ciStatus === "passing") {
        entry.ciStatus = "passing";
        entry.prStatus = "merged";
        result.passed.push(key);
        await transitionTicketToDone(entry, jiraClient);
      } else if (ciStatus === "failing") {
        entry.ciStatus = "failing";
        // Will be handled by fix delegation below
      }
      // "pending" → CI still running, leave as fix-pushed
    } catch (err) {
      logger.warn("Failed to check fix-pushed entry", { key, error: String(err) });
    }
  }

  // Find PRs to check: open PRs that haven't been marked needs-human yet
  const prEntries = Object.entries(state.patterns).filter(
    ([, entry]) =>
      entry.prStatus === "open" &&
      entry.ciStatus !== "needs-human" &&
      entry.ciStatus !== "passing" &&
      entry.ciStatus !== "fix-pushed" &&
      entry.prNumber
  );

  // Check CI status in parallel
  const checks = await Promise.all(
    prEntries.map(async ([key, entry]) => {
      const [owner, repo] = getOwnerRepo(key, config);
      if (!owner || !repo || !entry.prNumber) return { key, status: "pending" as const };
      try {
        const status = await githubClient.getPrChecks(owner, repo, entry.prNumber);
        return { key, status };
      } catch (err) {
        logger.warn("Failed to check CI", { key, error: String(err) });
        return { key, status: "pending" as const };
      }
    })
  );

  for (const { key, status } of checks) {
    const entry = state.patterns[key];
    if (!entry) continue;

    switch (status) {
      case "passing":
        entry.ciStatus = "passing";
        entry.prStatus = "merged"; // Stop re-checking on future runs
        result.passed.push(key);
        await transitionTicketToDone(entry, jiraClient);
        break;

      case "pending":
        result.pending.push(key);
        break;

      case "failing":
        if ((entry.ciAttempts || 0) >= config.pipeline.ciMaxFixAttempts) {
          // Max attempts reached — mark needs-human
          entry.ciStatus = "needs-human";
          result.needsHuman.push(key);

          if (entry.prNumber) {
            const [owner, repo] = getOwnerRepo(key, config);
            if (owner && repo) {
              try {
                await githubClient.addPrComment(
                  owner,
                  repo,
                  entry.prNumber,
                  `CI has failed ${entry.ciAttempts} times. Automated fix attempts exhausted. Needs human review.`
                );
              } catch (err) {
                logger.warn("Failed to add PR comment", { key, error: String(err) });
              }
            }
          }

          if (entry.jiraTicket) {
            try {
              await jiraClient.addLabel(entry.jiraTicket, "needs-human");
            } catch (err) {
              logger.warn("Failed to add Jira label", { key, error: String(err) });
            }
          }

          logger.warn("CI fix attempts exhausted", { key, attempts: entry.ciAttempts });
        } else {
          entry.ciStatus = "failing";
          result.failed.push(key);

          // Delegate to CI fixer
          const [fixOwner, fixRepo] = getOwnerRepo(key, config);
          const serviceName = key.split(":")[0];
          const service = config.services.find((s) => s.name === serviceName);
          if (fixOwner && fixRepo && service && entry.branch) {
            try {
              const ciFixResult = await fixCiFailure(
                entry,
                key,
                config.pipeline,
                fixOwner,
                fixRepo,
                service.repoLocalPath,
                githubClient,
                claudeClient,
                stateManager,
              );
              logger.info("CI fix result", { key, outcome: ciFixResult.outcome, attempts: ciFixResult.attempts });

              result.ciFixesAttempted++;
              if (ciFixResult.outcome === "passing" || ciFixResult.outcome === "fix-pushed") {
                result.ciFixesPushed++;
              }

              // Reload state after fixer (it writes state on each attempt)
              const freshEntry = stateManager.loadErrors().patterns[key];
              if (freshEntry) {
                entry.ciStatus = freshEntry.ciStatus;
                entry.ciAttempts = freshEntry.ciAttempts;
                entry.lastAttempt = freshEntry.lastAttempt;
              }
            } catch (err) {
              logger.error("CI fix delegation failed", { key, error: String(err) });
              // Safety: increment ciAttempts even on crash to prevent infinite retry
              const crashState = stateManager.loadErrors();
              if (crashState.patterns[key]) {
                crashState.patterns[key].ciAttempts = (crashState.patterns[key].ciAttempts || 0) + 1;
                crashState.patterns[key].lastAttempt = new Date().toISOString();
                stateManager.saveErrors(crashState);
              }
              result.ciFixesAttempted++;
            }
          } else {
            logger.info("CI failing, attempt noted (no repo for fix)", { key, attempt: entry.ciAttempts });
          }
        }
        break;
    }
  }

  // Check for stale needs-human entries
  const needsHumanEntries = Object.entries(state.patterns).filter(
    ([, entry]) => entry.ciStatus === "needs-human" && entry.jiraTicket
  );

  for (const [key, entry] of needsHumanEntries) {
    if (!entry.jiraTicket) continue;
    try {
      const issue = await jiraClient.getIssue(entry.jiraTicket);
      const createdDate = new Date(issue.created);
      const daysSince = Math.floor(
        (Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysSince >= config.pipeline.staleNeedsHumanDays) {
        result.staleReminders.push({
          key,
          jiraTicket: entry.jiraTicket,
          daysSinceCreated: daysSince,
        });
      }
    } catch (err) {
      logger.warn("Failed to check stale ticket age", { key, error: String(err) });
    }
  }

  // Check for follower release — if lead PR closed without merge, release followers
  const followerEntries = Object.entries(state.patterns).filter(
    ([, entry]) => entry.groupLeadKey
  );

  for (const [key, entry] of followerEntries) {
    const leadEntry = state.patterns[entry.groupLeadKey!];
    if (!leadEntry) {
      // Lead no longer exists — release follower
      entry.groupLeadKey = undefined;
      continue;
    }

    // If lead is resolved/merged, resolve follower
    if (leadEntry.prStatus === "merged" || leadEntry.status === "resolved") {
      entry.status = "resolved";
      entry.prStatus = leadEntry.prStatus;
      continue;
    }

    // If lead is abandoned or PR closed, release follower
    if (leadEntry.status === "abandoned" || leadEntry.prStatus === "closed") {
      entry.groupLeadKey = undefined;
      entry.status = "active";
      continue;
    }
  }

  // Check for externally closed PRs
  for (const [key, entry] of Object.entries(state.patterns)) {
    if (entry.prStatus !== "open" || !entry.prNumber) continue;
    const [prOwner, prRepo] = getOwnerRepo(key, config);
    if (!prOwner || !prRepo) continue;

    try {
      const prState = await githubClient.getPrState(prOwner, prRepo, entry.prNumber);
      if (prState.state === "closed") {
        entry.prStatus = prState.merged ? "merged" : "closed";
        if (prState.merged) {
          entry.ciStatus = "passing";
          entry.status = "resolved";
          await transitionTicketToDone(entry, jiraClient);
        }
      }
    } catch {
      // Skip — will check next run
    }
  }

  // Reload state before saving — patch ALL fields CI monitor touches
  const freshState = stateManager.loadErrors();
  for (const [key, entry] of Object.entries(state.patterns)) {
    const target = freshState.patterns[key];
    if (target) {
      target.ciStatus = entry.ciStatus;
      target.ciAttempts = entry.ciAttempts;
      target.prStatus = entry.prStatus;
      target.status = entry.status;
      target.groupLeadKey = entry.groupLeadKey;
    }
  }
  stateManager.saveErrors(freshState);
  return result;
}

function getOwnerRepo(key: string, config: AppConfig): [string, string] | [null, null] {
  const service = key.split(":")[0];
  const svc = config.services.find((s) => s.name === service);
  if (!svc) return [null, null];
  const parts = svc.githubRepo.split("/");
  return parts.length === 2 ? [parts[0], parts[1]] : [null, null];
}
