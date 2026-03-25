// src/pipeline/ci-fixer.ts
import type { ErrorEntry } from "../state/types.js";
import type { StateManager } from "../state/manager.js";
import type { GitHubClient } from "../integrations/github.js";
import type { ClaudeClient } from "../integrations/claude.js";
import type { PipelineConfig } from "../config.js";
import { git } from "../utils/git.js";
import { sanitizeLogSamples } from "../utils/sanitizer.js";
import { logger } from "../utils/logger.js";

// Note: Outcomes expanded from spec's "fix-pushed | skipped | failed" to be more granular
export interface CiFixResult {
  outcome: "passing" | "fix-pushed" | "no-changes" | "budget-exhausted" | "failed";
  attempts: number;
}

/**
 * Extract the failing step's output from a GitHub Actions job log.
 * Logs are delimited by ##[group]Step Name and ##[endgroup] markers.
 * Returns the content of the failing step, truncated to maxLines (keeping tail).
 */
export function extractFailingStepLog(
  fullLog: string,
  failedStepName: string,
  maxLines = 200,
): string {
  if (!fullLog) return "";

  const groupStart = `##[group]${failedStepName}`;
  const startIdx = fullLog.indexOf(groupStart);

  let section: string;
  if (startIdx === -1) {
    section = fullLog;
  } else {
    const afterGroup = fullLog.indexOf("\n", startIdx);
    const endIdx = fullLog.indexOf("##[endgroup]", afterGroup);
    section = endIdx === -1
      ? fullLog.substring(afterGroup + 1)
      : fullLog.substring(afterGroup + 1, endIdx);
  }

  const lines = section.split("\n");
  if (lines.length <= maxLines) return section.trim();

  const truncated = lines.slice(lines.length - maxLines);
  return `[...truncated ${lines.length - maxLines} lines...]\n${truncated.join("\n")}`.trim();
}

/**
 * Poll for CI completion on a branch.
 */
export async function waitForCi(
  githubClient: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  expectedSha: string,
  pollIntervalMs = 30_000,
  timeoutMs = 600_000,
): Promise<"passing" | "failing" | "timeout"> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const run = await githubClient.getLatestWorkflowRun(owner, repo, branch);
      if (run && run.headSha === expectedSha && run.status === "completed") {
        return run.conclusion === "success" ? "passing" : "failing";
      }
    } catch (err) {
      logger.warn("CI poll error", { error: String(err) });
    }

    if (Date.now() + pollIntervalMs >= deadline) break;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  return "timeout";
}

/**
 * Attempt to fix CI failures on a PR branch.
 * Inline poll-and-retry loop: push fix -> poll CI -> repeat if failing.
 */
export async function fixCiFailure(
  entry: ErrorEntry,
  key: string,
  pipelineConfig: PipelineConfig,
  owner: string,
  repo: string,
  repoPath: string,
  githubClient: GitHubClient,
  claudeClient: ClaudeClient,
  stateManager: StateManager,
): Promise<CiFixResult> {
  const loopStart = Date.now();
  let attempts = 0;
  let previousFailureContext = "";

  while (
    entry.ciAttempts < pipelineConfig.ciMaxFixAttempts &&
    Date.now() - loopStart < pipelineConfig.ciRetryBudgetMinutes * 60_000
  ) {
    attempts++;
    logger.info("CI fix attempt", { key, attempt: entry.ciAttempts + 1, branch: entry.branch });

    // 1. Get latest workflow run
    const workflowRun = await githubClient.getLatestWorkflowRun(owner, repo, entry.branch!);
    if (!workflowRun || workflowRun.status !== "completed" || workflowRun.conclusion !== "failure") {
      logger.info("No completed failing workflow run found", { key });
      return { outcome: "failed", attempts };
    }

    // Verify SHA matches branch HEAD to avoid stale runs
    const branchHead = git(repoPath, ["rev-parse", `origin/${entry.branch}`]);
    if (workflowRun.headSha !== branchHead) {
      logger.info("Stale workflow run, waiting for CI on new commit", { key, expected: branchHead, got: workflowRun.headSha });
      const ciResult = await waitForCi(
        githubClient, owner, repo, entry.branch!,
        branchHead, pipelineConfig.ciPollIntervalMs, pipelineConfig.ciPollTimeoutMs,
      );
      if (ciResult === "passing") {
        entry.ciStatus = "passing";
        const state = stateManager.loadErrors();
        if (state.patterns[key]) {
          state.patterns[key].ciStatus = "passing";
          stateManager.saveErrors(state);
        }
        return { outcome: "passing", attempts };
      }
      if (ciResult === "timeout") {
        entry.ciStatus = "fix-pushed";
        const state = stateManager.loadErrors();
        if (state.patterns[key]) {
          state.patterns[key].ciStatus = "fix-pushed";
          stateManager.saveErrors(state);
        }
        return { outcome: "fix-pushed", attempts };
      }
      continue;
    }

    // 2. Download failure logs
    const failedJobs = await githubClient.getFailedJobs(owner, repo, workflowRun.runId);
    if (failedJobs.length === 0) {
      logger.warn("No failed jobs found in workflow run", { key, runId: workflowRun.runId });
      return { outcome: "failed", attempts };
    }

    let failureLog = "";
    const failedStepName = failedJobs[0].failedStep;
    try {
      const rawLog = await githubClient.downloadJobLog(owner, repo, failedJobs[0].jobId);
      failureLog = extractFailingStepLog(rawLog, failedStepName);
    } catch (err) {
      logger.warn("Failed to download job log", { key, error: String(err) });
      failureLog = `Failed to download logs. Job: ${failedJobs[0].jobName}, Step: ${failedStepName}`;
    }

    // 3. Invoke Claude Code to fix
    try {
      git(repoPath, ["fetch", "origin", entry.branch!]);
      git(repoPath, ["checkout", entry.branch!]);
      git(repoPath, ["pull", "--ff-only", "origin", entry.branch!]);
    } catch (err) {
      logger.error("Failed to checkout fix branch", { key, branch: entry.branch, error: String(err) });
      return { outcome: "failed", attempts };
    }

    const previousContext = previousFailureContext
      ? `\n\n## Previous Attempt\nYour previous fix attempt failed with these errors:\n${previousFailureContext}\n`
      : "";

    const prompt = `Fix the CI failure on this branch. Make minimal changes.

## Context
This branch has an automated fix for a production bug. CI is failing.
${entry.analysis ? `Original bug: ${entry.analysis.errorPattern}\nRoot cause: ${entry.analysis.rootCauseHypothesis}` : ""}
${previousContext}

## CI Failure
**Failed step:** ${failedStepName}
**Job:** ${failedJobs[0].jobName}

**Failure output:**
\`\`\`
${failureLog}
\`\`\`

## Rules
- Fix ONLY the CI failure — do not change unrelated code
- If tests are failing, fix the code or the tests (prefer fixing code)
- Run the test suite after making changes to verify
- Keep changes minimal and focused`;

    const codeEditResult = await claudeClient.codeEdit(
      prompt,
      repoPath,
      ["Edit", "Read", "Write", "Bash", "Grep", "Glob"],
      "sonnet",
    );

    // 4. Check if Claude made changes
    const diffOutput = git(repoPath, ["diff", "--name-only"]);
    const stagedOutput = git(repoPath, ["diff", "--name-only", "--cached"]);
    const newCommits = git(repoPath, ["log", `origin/${entry.branch}..HEAD`, "--oneline"]).trim();
    const hasUncommitted = (diffOutput + stagedOutput).trim().length > 0;
    const hasNewCommits = newCommits.length > 0;

    if (!hasUncommitted && !hasNewCommits) {
      logger.warn("CI fixer made no changes", { key, response: codeEditResult.text.substring(0, 300) });
      entry.ciAttempts++;
      entry.lastAttempt = new Date().toISOString();
      const state = stateManager.loadErrors();
      if (state.patterns[key]) {
        state.patterns[key].ciAttempts = entry.ciAttempts;
        state.patterns[key].lastAttempt = entry.lastAttempt;
        stateManager.saveErrors(state);
      }
      return { outcome: "no-changes", attempts };
    }

    // 5. Stage individual files, commit, push
    if (hasUncommitted) {
      const changedFiles = [...new Set(
        [...diffOutput.split("\n"), ...stagedOutput.split("\n")].filter(Boolean)
      )];
      for (const file of changedFiles) {
        git(repoPath, ["add", file]);
      }
      git(repoPath, ["commit", "-m", `fix: address CI failure (attempt ${entry.ciAttempts + 1})`]);
    }

    const headSha = git(repoPath, ["rev-parse", "HEAD"]);
    git(repoPath, ["push", "origin", entry.branch!]);

    // Update state
    entry.ciAttempts++;
    entry.lastAttempt = new Date().toISOString();
    entry.ciStatus = "fix-pushed";
    {
      const state = stateManager.loadErrors();
      if (state.patterns[key]) {
        state.patterns[key].ciAttempts = entry.ciAttempts;
        state.patterns[key].lastAttempt = entry.lastAttempt;
        state.patterns[key].ciStatus = "fix-pushed";
        stateManager.saveErrors(state);
      }
    }

    // Add PR comment (sanitize to avoid leaking secrets)
    if (entry.prNumber) {
      try {
        const fixSummary = sanitizeLogSamples([codeEditResult.text.substring(0, 500)])[0];
        await githubClient.addPrComment(
          owner,
          repo,
          entry.prNumber,
          `## CI Fix Attempt ${entry.ciAttempts}\n\n**Failed step:** ${failedStepName}\n\n**Fix applied:**\n${fixSummary}`,
        );
      } catch { /* best-effort */ }
    }

    // 6. Poll for CI completion
    const ciResult = await waitForCi(
      githubClient, owner, repo, entry.branch!, headSha,
      pipelineConfig.ciPollIntervalMs, pipelineConfig.ciPollTimeoutMs,
    );

    if (ciResult === "passing") {
      entry.ciStatus = "passing";
      const state = stateManager.loadErrors();
      if (state.patterns[key]) {
        state.patterns[key].ciStatus = "passing";
        stateManager.saveErrors(state);
      }
      return { outcome: "passing", attempts };
    }

    if (ciResult === "timeout") {
      return { outcome: "fix-pushed", attempts };
    }

    // CI failed again — store context for next attempt
    previousFailureContext = failureLog.substring(0, 1000);

    // Reset to fix branch for next attempt
    try {
      git(repoPath, ["fetch", "origin", entry.branch!]);
      git(repoPath, ["reset", "--hard", `origin/${entry.branch}`]);
    } catch { /* best effort */ }
  }

  // Loop exhausted
  if (entry.ciAttempts >= pipelineConfig.ciMaxFixAttempts) {
    return { outcome: "failed", attempts };
  }
  return { outcome: "budget-exhausted", attempts };
}
