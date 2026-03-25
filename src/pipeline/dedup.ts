// src/pipeline/dedup.ts
import type { ScannedError } from "../types.js";
import type { StateManager } from "../state/manager.js";
import type { JiraClient } from "../integrations/jira.js";
import { logger } from "../utils/logger.js";

export interface DedupResult {
  newErrors: ScannedError[];
  duplicates: ScannedError[];
}

/**
 * Deduplicate scanned errors against local state and Jira.
 * Runs BEFORE classification so we don't waste Haiku tokens on known errors.
 */
export async function deduplicate(
  errors: ScannedError[],
  stateManager: StateManager,
  jiraClient?: JiraClient
): Promise<DedupResult> {
  const state = stateManager.loadErrors();
  const newErrors: ScannedError[] = [];
  const duplicates: ScannedError[] = [];

  for (const error of errors) {
    const key = `${error.service}:${error.environment}:${error.pattern}`;
    const existing = state.patterns[key];

    if (existing) {
      // Pattern exists in local state
      const isResolved = existing.prStatus === "merged" || existing.prStatus === "closed" || existing.status === "resolved";

      if (isResolved) {
        // Resolved patterns are treated as new
        newErrors.push(error);
      } else {
        // Check if linked Jira ticket was deleted externally
        if (existing.jiraTicket && !existing.prUrl && jiraClient) {
          let ticketAlive = true;
          try {
            ticketAlive = await jiraClient.issueExists(existing.jiraTicket);
          } catch {
            // On error, assume ticket exists to avoid duplicate creation
          }

          if (!ticketAlive) {
            logger.info("Jira ticket deleted externally, clearing state for re-processing", {
              key,
              deletedTicket: existing.jiraTicket,
            });
            delete existing.jiraTicket;
            delete existing.jiraUrl;
            delete existing.analysis;
            existing.failureCount = 0;
            existing.ciAttempts = 0;
            existing.status = "active";
            newErrors.push(error);
            continue;
          }
        }

        // Active pattern — update occurrence data
        const previousCount = existing.count;
        existing.lastSeen = error.lastSeen;
        existing.count = error.occurrenceCount;

        // 2× re-evaluation: if count has doubled, add Jira comment
        if (
          jiraClient &&
          existing.jiraTicket &&
          previousCount > 0 &&
          error.occurrenceCount >= previousCount * 2
        ) {
          try {
            await jiraClient.addComment(
              existing.jiraTicket,
              `Occurrence count update: ${error.occurrenceCount} (was ${previousCount}). Pattern is recurring at an increased rate.`
            );
            logger.info("Updated Jira with doubled count", {
              ticket: existing.jiraTicket,
              from: previousCount,
              to: error.occurrenceCount,
            });
          } catch (err) {
            logger.warn("Failed to update Jira comment", { error: String(err) });
          }
        }

        duplicates.push(error);
      }
    } else {
      // Not in local state — check Jira as fallback (Layer 2)
      if (jiraClient) {
        try {
          const escapedPattern = error.pattern
            .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ") // Strip Lucene special chars
            .substring(0, 100); // Length limit
          const jql = `labels = "auto-detected" AND summary ~ "${escapedPattern}" AND (status != Done OR resolved >= -7d)`;
          const results = await jiraClient.searchIssues(jql);
          if (results.length > 0) {
            logger.info("Found existing Jira ticket via search", {
              pattern: error.pattern,
              ticket: results[0].key,
            });
            // Add to local state as duplicate — use "unknown" priority since classification hasn't run
            state.patterns[key] = {
              status: "active",
              firstSeen: error.firstSeen,
              lastSeen: error.lastSeen,
              count: error.occurrenceCount,
              priority: "unknown",
              prioritySource: "unknown",
              jiraTicket: results[0].key,
              ciAttempts: 0,
              failureCount: 0,
              slackNotified: false,
            };
            duplicates.push(error);
            continue;
          }
        } catch (err) {
          logger.warn("Jira search fallback failed", { error: String(err) });
        }
      }

      // Truly new error
      newErrors.push(error);
    }
  }

  stateManager.saveErrors(state);
  return { newErrors, duplicates };
}
