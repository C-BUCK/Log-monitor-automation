// src/pipeline/notifier.ts
import type { RunSummary } from "../types.js";
import type { SlackClient } from "../integrations/slack.js";
import { logger } from "../utils/logger.js";

const PRIORITY_EMOJI: Record<string, string> = {
  Critical: "🔴",
  High: "🟠",
  Medium: "🟡",
  Low: "🟢",
};

export function formatDigest(
  summary: RunSummary,
  staleReminders: Array<{ key: string; jiraTicket: string; daysSinceCreated: number }>,
  consecutiveFailures: number,
  costAlertThreshold: number
): string {
  const lines: string[] = [];
  const startDate = new Date(summary.startedAt);
  const endDate = new Date(summary.completedAt);
  const durationSec = Math.round((endDate.getTime() - startDate.getTime()) / 1000);

  lines.push(`📊 Log Monitor Run — ${startDate.toUTCString()}`);
  lines.push("");

  // Escalation
  if (consecutiveFailures >= 3) {
    lines.push(`🚨 @channel — ${consecutiveFailures} consecutive run failures`);
    lines.push("");
  }

  // Scan summary
  lines.push(
    `🔍 Scanned: Errors found: ${summary.errorsScanned} | New: ${summary.newErrors} | Duplicates: ${summary.deduplicatedErrors} | Deferred: ${summary.deferredErrors}`
  );
  lines.push("");

  // Grouping summary
  if (summary.groupsFormed && summary.groupsFormed > 0) {
    lines.push(
      `🔗 Grouping: ${summary.groupsFormed} groups formed, ${summary.followersSkipped ?? 0} duplicate errors skipped`
    );
    lines.push("");
  }

  if (summary.newErrors === 0 && summary.jobs.length === 0) {
    lines.push("✅ All clear — no new errors detected");
    lines.push("");
  } else {
    // New issues
    const newJobs = summary.jobs.filter((j) => j.outcome !== "skipped");
    if (newJobs.length > 0) {
      lines.push("🆕 New Issues:");
      for (const job of newJobs) {
        const emoji = PRIORITY_EMOJI[job.error.priority] || "⚪";
        const ticket = job.jiraTicket || "pending";
        const pr = job.prUrl ? `→ PR ${job.prUrl}` : "";
        const status = job.outcome === "needs-human" ? " ⚠️ needs-human" : "";
        lines.push(
          `  ${emoji} ${job.error.priority} — "${job.error.pattern}" (${job.error.occurrenceCount}x) → ${ticket} ${pr}${status}`
        );
      }
      lines.push("");
    }
  }

  // CI status
  if (summary.ciPassed > 0) {
    lines.push(`✅ CI Passing: ${summary.ciPassed} PRs ready for review`);
    lines.push("");
  }

  if (summary.ciFailed > 0) {
    lines.push(`❌ CI Failing: ${summary.ciFailed} PRs need attention`);
    lines.push("");
  }

  // CI fix attempts
  if (summary.ciFixesAttempted && summary.ciFixesAttempted > 0) {
    lines.push(
      `🔧 CI fixes: ${summary.ciFixesAttempted} attempted, ${summary.ciFixesPushed ?? 0} pushed`
    );
    lines.push("");
  }

  // Stale needs-human reminders
  if (staleReminders.length > 0) {
    lines.push("⏰ Stale needs-human reminders:");
    for (const reminder of staleReminders) {
      lines.push(`  ${reminder.jiraTicket} — open for ${reminder.daysSinceCreated} days`);
    }
    lines.push("");
  }

  // Cost
  lines.push(`💰 Cost: $${summary.costEstimateUsd.toFixed(2)} | Duration: ${durationSec}s`);
  if (summary.costEstimateUsd > costAlertThreshold) {
    lines.push(
      `⚠️ Cost alert: $${summary.costEstimateUsd.toFixed(2)} exceeds threshold of $${costAlertThreshold}`
    );
  }

  // Failed steps
  if (summary.failedSteps.length > 0) {
    lines.push("");
    lines.push(`⚠️ Failed steps: ${summary.failedSteps.join(", ")}`);
  }

  return lines.join("\n");
}

export async function notify(
  summary: RunSummary,
  staleReminders: Array<{ key: string; jiraTicket: string; daysSinceCreated: number }>,
  consecutiveFailures: number,
  costAlertThreshold: number,
  slackClient: SlackClient
): Promise<boolean> {
  const digest = formatDigest(summary, staleReminders, consecutiveFailures, costAlertThreshold);
  logger.info("Posting digest to Slack", { length: digest.length });
  return slackClient.postMessage(digest);
}
