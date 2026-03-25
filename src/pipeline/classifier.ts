// src/pipeline/classifier.ts
import fs from "node:fs";
import type { ScannedError, ClassifiedError, ClassificationRule, Priority, PrioritySource } from "../types.js";
import type { ClaudeClient } from "../integrations/claude.js";
import { logger } from "../utils/logger.js";

export function loadRules(path: string): ClassificationRule[] {
  const content = fs.readFileSync(path, "utf-8");
  return JSON.parse(content) as ClassificationRule[];
}

export function classify(error: ScannedError, rules: ClassificationRule[]): ClassifiedError {
  // Layer 1: Rules match (check both exampleMessage and pattern field)
  const textToMatch = `${error.exampleMessage} ${error.pattern}`;
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, "i");
      if (regex.test(textToMatch)) {
        return { ...error, priority: rule.priority, prioritySource: "rule" };
      }
    } catch {
      logger.warn("Skipping malformed rule pattern", { pattern: rule.pattern });
    }
  }

  // Layer 2: Frequency heuristic
  let priority: Priority;
  if (error.occurrenceCount >= 100) {
    priority = "High";
  } else if (error.occurrenceCount >= 10) {
    priority = "Medium";
  } else {
    priority = "Low";
  }

  return { ...error, priority, prioritySource: "frequency" };
}

export function classifyAll(errors: ScannedError[], rules: ClassificationRule[]): ClassifiedError[] {
  return errors
    .map((e) => classify(e, rules))
    .filter((e) => e.priority !== "Skip");
}

/**
 * Async version that optionally uses Haiku for ambiguous Medium-frequency errors.
 * Only calls Haiku when:
 * - Error was classified as Medium by frequency (not by rules)
 * - A ClaudeClient is provided
 * - Occurrence count is 10-99
 */
export async function classifyAllAsync(
  errors: ScannedError[],
  rules: ClassificationRule[],
  claudeClient?: ClaudeClient
): Promise<ClassifiedError[]> {
  const results: ClassifiedError[] = [];

  for (const error of errors) {
    let classified = classify(error, rules);

    // Layer 3: Haiku override for ambiguous Medium-frequency errors
    if (
      classified.prioritySource === "frequency" &&
      classified.priority === "Medium" &&
      claudeClient
    ) {
      try {
        const { text } = await claudeClient.complete(
          "haiku",
          "You are a severity classifier for production errors. Respond with ONLY one word: Critical, High, Medium, or Low.",
          `Error pattern: ${error.pattern}\nMessage: ${error.exampleMessage}\nOccurrences in 8h: ${error.occurrenceCount}\nLevel: ${error.level}\nComponent: ${error.component || "unknown"}\n\nClassify the severity:`,
          50
        );

        const haikuPriority = parseHaikuPriority(text.trim());
        if (haikuPriority) {
          logger.info("Haiku reclassified error", {
            pattern: error.pattern,
            from: classified.priority,
            to: haikuPriority,
          });
          classified = { ...classified, priority: haikuPriority, prioritySource: "haiku" };
        }
      } catch (err) {
        logger.warn("Haiku classification failed, keeping frequency-based priority", {
          pattern: error.pattern,
          error: String(err),
        });
      }
    }

    if (classified.priority !== "Skip") {
      results.push(classified);
    }
  }

  return results;
}

function parseHaikuPriority(text: string): Priority | null {
  const normalized = text.toLowerCase();
  if (/\bcritical\b/.test(normalized)) return "Critical";
  if (/\bhigh\b/.test(normalized)) return "High";
  if (/\bmedium\b/.test(normalized)) return "Medium";
  if (/\blow\b/.test(normalized)) return "Low";
  return null;
}
