// src/pipeline/analyzer.ts
import type { ClassifiedError, AnalysisResult } from "../types.js";
import type { ClaudeClient } from "../integrations/claude.js";
import { sanitizeLogSamples } from "../utils/sanitizer.js";
import { logger } from "../utils/logger.js";

export async function analyze(
  error: ClassifiedError,
  repoPath: string,
  claudeClient: ClaudeClient
): Promise<AnalysisResult> {
  const prompt = `You are analyzing a production error in this repository. Investigate the codebase to find the root cause.

## Error Details
- Pattern: ${error.pattern}
- Service: ${error.service} (${error.environment})
- Level: ${error.level}
- Component: ${error.component || "unknown"}
- Occurrences (8hr): ${error.occurrenceCount}
- Example message: ${error.exampleMessage}

## Raw Log Samples
${sanitizeLogSamples(error.rawSamples).map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Instructions
1. Search the codebase for files related to this error (use the component name, error message keywords, etc.)
2. Read the relevant source files to understand the context
3. Identify the root cause

Respond ONLY with a JSON object (no markdown, no code fences) matching this schema:
{
  "component": "string - the component/module name",
  "affectedFiles": ["array of file paths relative to repo root"],
  "relevantLines": "string - line range like L245-L280",
  "rootCauseHypothesis": "string - what's causing the error",
  "suggestedApproach": "string - how to fix it",
  "category": "string - error category like 'connection', 'validation', 'timeout', 'logic'"
}`;

  try {
    const { text } = await claudeClient.codeEdit(
      prompt,
      repoPath,
      ["Read", "Grep", "Glob"],
      "sonnet"
    );
    return parseAnalysisResponse(text, error);
  } catch (err) {
    logger.error("Analysis failed, using defaults", { pattern: error.pattern, error: String(err) });
    return buildDefaultAnalysis(error);
  }
}

/** Find the last balanced JSON object in text, searching from the end */
function findLastJsonObject(text: string): RegExpMatchArray | null {
  let lastOpen = text.lastIndexOf("{");
  while (lastOpen >= 0) {
    // Find matching closing brace by counting depth
    let depth = 0;
    for (let i = lastOpen; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      if (depth === 0) {
        const candidate = text.substring(lastOpen, i + 1);
        // Return in RegExpMatchArray-like shape: [fullMatch, group1]
        return [candidate, candidate] as unknown as RegExpMatchArray;
      }
    }
    lastOpen = text.lastIndexOf("{", lastOpen - 1);
  }
  return null;
}

function parseAnalysisResponse(text: string, error: ClassifiedError): AnalysisResult {
  // Try JSON extraction first (with or without code fences)
  // Try code-fenced JSON first, then find the last JSON object in the text
  // (non-greedy would stop at the first }, greedy grabs too much — find balanced braces)
  const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || findLastJsonObject(text);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        errorPattern: error.pattern,
        service: error.service,
        environment: error.environment,
        githubRepo: error.githubRepo,
        component: parsed.component || error.component || "unknown",
        affectedFiles: Array.isArray(parsed.affectedFiles) ? parsed.affectedFiles : [],
        relevantLines: parsed.relevantLines || "",
        rootCauseHypothesis: parsed.rootCauseHypothesis || "Analysis inconclusive",
        suggestedApproach: parsed.suggestedApproach || "Manual investigation needed",
        rawLogSamples: error.rawSamples,
        category: parsed.category || "unknown",
      };
    } catch {
      // JSON parse failed — fall through to text extraction
    }
  }

  // Fallback: extract what we can from free-form text
  logger.info("Extracting analysis from free-form text", { pattern: error.pattern });
  const extractField = (labels: string[]): string => {
    for (const label of labels) {
      const match = text.match(new RegExp(`(?:${label})[:\\s]*([^\\n]+(?:\\n(?![A-Z][a-z]+:)[^\\n]+)*)`, "i"));
      if (match) return match[1].trim();
    }
    return "";
  };

  const fileMatches = text.match(/[\w/.-]+\.\w{1,4}(?::\d+)?/g) || [];
  const affectedFiles = [...new Set(fileMatches.filter(f => !f.startsWith("http")))];

  return {
    errorPattern: error.pattern,
    service: error.service,
    environment: error.environment,
    githubRepo: error.githubRepo,
    component: extractField(["component", "module"]) || error.component || "unknown",
    affectedFiles,
    relevantLines: extractField(["relevant.?lines", "line.?range"]),
    rootCauseHypothesis: extractField(["root.?cause", "hypothesis", "cause", "problem", "issue"]) || text.substring(0, 500),
    suggestedApproach: extractField(["suggested.?approach", "fix", "solution", "recommendation"]) || "",
    rawLogSamples: error.rawSamples,
    category: extractField(["category", "type"]) || "unknown",
  };
}

export function buildDefaultAnalysis(error: ClassifiedError): AnalysisResult {
  return {
    errorPattern: error.pattern,
    service: error.service,
    environment: error.environment,
    githubRepo: error.githubRepo,
    component: error.component || "unknown",
    affectedFiles: [],
    relevantLines: "",
    rootCauseHypothesis: `Error pattern "${error.pattern}" with ${error.occurrenceCount} occurrences. Manual investigation needed.`,
    suggestedApproach: "Review the error logs and affected files to identify root cause.",
    rawLogSamples: error.rawSamples,
    category: "unknown",
  };
}
