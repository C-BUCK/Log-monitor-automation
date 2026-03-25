// src/pipeline/fixer.ts
import type { AnalysisResult, ClaudeModel } from "../types.js";
import type { ClaudeClient } from "../integrations/claude.js";
import type { GitHubClient } from "../integrations/github.js";
import type { JiraClient } from "../integrations/jira.js";
import { git, resetToLatest, remoteBranchExists } from "../utils/git.js";
import { sanitizeLogSamples } from "../utils/sanitizer.js";
import { logger } from "../utils/logger.js";

export interface FixResult {
  outcome: "success" | "failed" | "needs-human" | "already-fixed";
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  failureReason?: string;
}

const MIGRATION_PATTERNS = [/migration/i, /schema.*change/i, /\.sql$/i, /alembic/i, /drizzle.*migrate/i];

export async function fix(
  analysis: AnalysisResult,
  priority: string,
  jiraTicket: string,
  jiraUrl: string,
  repoPath: string,
  targetBranch: string,
  githubClient: GitHubClient,
  claudeClient: ClaudeClient,
  jiraClient: JiraClient
): Promise<FixResult> {
  const [owner, repo] = analysis.githubRepo.split("/");
  const shortId = analysis.errorPattern.replace(/[^a-zA-Z0-9]/g, "-").substring(0, 30).toLowerCase();
  let branchName = `fix/${analysis.service}-${shortId}`;

  // Check for migration/schema files — refuse to auto-fix
  if (analysis.affectedFiles.some((f) => MIGRATION_PATTERNS.some((p) => p.test(f)))) {
    logger.warn("Affected files include migrations/schema — marking needs-human", { files: analysis.affectedFiles });
    return { outcome: "needs-human", failureReason: "Affected files include database migrations or schema changes" };
  }

  // Idempotency: check for existing PR
  try {
    const existingPr = await githubClient.findPrForBranch(owner, repo, branchName);
    if (existingPr) {
      logger.info("PR already exists for branch", { branch: branchName, pr: existingPr.url });
      return { outcome: "success", branch: branchName, prUrl: existingPr.url, prNumber: existingPr.number };
    }
  } catch (err) {
    logger.warn("Failed to check for existing PR", { error: String(err) });
  }

  try {
    // Reset to latest target branch
    resetToLatest(repoPath, targetBranch);

    // Check if branch exists on remote — if so, try version suffixes
    if (remoteBranchExists(repoPath, branchName)) {
      let found = false;
      for (let v = 2; v <= 5; v++) {
        const vBranch = `${branchName}-v${v}`;
        if (!remoteBranchExists(repoPath, vBranch)) {
          branchName = vBranch;
          found = true;
          break;
        }
      }
      if (!found) {
        return { outcome: "needs-human", branch: branchName, failureReason: "Too many existing fix branches (v2-v5 all taken)" };
      }
    }

    // Create fix branch
    git(repoPath, ["checkout", "-b", branchName]);

    // Transition Jira ticket to "In Progress"
    try {
      await jiraClient.transitionTo(jiraTicket, "In Progress");
    } catch (err) {
      logger.warn("Failed to transition Jira ticket", { jiraTicket, error: String(err) });
    }

    // Select model based on priority
    const model: ClaudeModel = priority === "Critical" ? "opus" : "sonnet";

    // Build prompt for Claude Code — it will read files, make edits, and run tests itself
    const prompt = buildFixPrompt(analysis);

    // Let Claude Code work in the repo with full tool access
    const codeEditResult = await claudeClient.codeEdit(
      prompt,
      repoPath,
      ["Edit", "Read", "Write", "Bash", "Grep", "Glob"],
      model
    );

    // Check if Claude actually made any changes
    const diffOutput = git(repoPath, ["diff", "--name-only"]);
    const stagedOutput = git(repoPath, ["diff", "--name-only", "--cached"]);
    let changedFiles = [...new Set([...diffOutput.split("\n"), ...stagedOutput.split("\n")].filter(Boolean))];

    // Check if Claude already committed (diff would be empty but HEAD moved)
    const newCommits = git(repoPath, ["log", `${targetBranch}..HEAD`, "--oneline"]).trim();
    const hasUncommittedChanges = changedFiles.length > 0;
    const hasNewCommits = newCommits.length > 0;

    // If Claude already committed, get the actual changed files from those commits
    if (!hasUncommittedChanges && hasNewCommits) {
      const committedFiles = git(repoPath, ["diff", "--name-only", `origin/${targetBranch}`, "HEAD"]);
      changedFiles = committedFiles.split("\n").filter(Boolean);
    }

    if (!hasUncommittedChanges && !hasNewCommits) {
      const responseSnippet = codeEditResult.text.substring(0, 500);
      const responseLower = codeEditResult.text.toLowerCase();
      const alreadyFixed = responseLower.includes("already fixed")
        || responseLower.includes("already been fixed")
        || responseLower.includes("does not exist on this branch")
        || responseLower.includes("no changes are needed")
        || responseLower.includes("no change") && responseLower.includes("needed")
        || responseLower.includes("bug is already")
        || responseLower.includes("already resolved");

      if (alreadyFixed) {
        logger.info("Bug already fixed on target branch", { pattern: analysis.errorPattern, claudeResponse: responseSnippet });
        return { outcome: "already-fixed", branch: branchName, failureReason: `Already fixed on target branch. Response: ${responseSnippet}` };
      }

      logger.warn("Claude Code made no changes", { pattern: analysis.errorPattern, claudeResponse: responseSnippet });
      return { outcome: "failed", branch: branchName, failureReason: `Claude Code made no file changes. Response: ${responseSnippet}` };
    }

    if (hasUncommittedChanges) {
      // Stage and commit only if Claude didn't already commit
      for (const file of changedFiles) {
        git(repoPath, ["add", file]);
      }
      const commitMsg = `fix: ${analysis.errorPattern.substring(0, 72)}`;
      git(repoPath, ["commit", "-m", commitMsg]);
    } else {
      logger.info("Claude Code already committed changes", { commits: newCommits });
    }

    // Push, then wait briefly — GitHub needs time to process the new branch
    // before the REST API can create a PR against it
    git(repoPath, ["push", "origin", branchName]);
    await new Promise((r) => setTimeout(r, 2000));

    // Create PR
    const sanitizedSamples = sanitizeLogSamples(analysis.rawLogSamples);
    const actualFixSummary = extractFixSummary(codeEditResult.text);
    const prBody = buildPrBody(analysis, jiraTicket, jiraUrl, sanitizedSamples, changedFiles.length, actualFixSummary);
    const pr = await githubClient.createPr(
      owner,
      repo,
      branchName,
      targetBranch,
      `${jiraTicket}: ${analysis.errorPattern.substring(0, 60)}`,
      prBody
    );

    logger.info("Created fix PR", { pr: pr.url, branch: branchName, filesEdited: changedFiles.length });
    return { outcome: "success", branch: branchName, prUrl: pr.url, prNumber: pr.number };
  } catch (err) {
    logger.error("Fix failed", { pattern: analysis.errorPattern, error: String(err) });
    // Clean up git state so the next fix or analysis starts clean
    try { resetToLatest(repoPath, targetBranch); } catch { /* best-effort */ }
    return { outcome: "failed", branch: branchName, failureReason: String(err) };
  }
}

function buildFixPrompt(analysis: AnalysisResult): string {
  return `Fix a production bug in this repository. Make minimal, focused changes.

## Important Context
This error was found in **production (main branch)**, but you are working on the **development branch**. The affected files may have already been modified on this branch. Check the current state of the code — if the bug is already fixed here, make no changes.

## Bug Report

**Error Pattern:** ${analysis.errorPattern}
**Component:** ${analysis.component}
**Category:** ${analysis.category}

**Root Cause (observed on production/main):**
${analysis.rootCauseHypothesis}

**Suggested Approach:**
${analysis.suggestedApproach}

**Affected Files (on production — verify these still apply):**
${analysis.affectedFiles.map((f) => `- ${f}`).join("\n")}

**Raw Log Samples:**
${analysis.rawLogSamples.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Rules
- First check if the bug still exists on this branch — if not, make no changes
- Only modify files related to this bug
- Do not add unrelated changes, refactoring, or documentation
- If modifying tested code, update the tests too
- Follow the repository's coding conventions
- Run the test suite after making changes to verify the fix works
- Keep the fix minimal and focused`;
}

export function extractFixSummary(claudeResponse: string): string {
  let text = claudeResponse;

  // Try to extract a structured section (Summary, Changes, Fix)
  const sectionMatch = text.match(/##\s*(?:Summary|Changes|Fix Applied?)\s*\n([\s\S]*?)(?=\n##|\n---|$)/i);
  if (sectionMatch) {
    text = sectionMatch[1].trim();
  }

  // Strip code blocks longer than 10 lines
  text = text.replace(/```[\s\S]*?```/g, (block) => {
    const lines = block.split("\n");
    return lines.length > 12 ? "[code block omitted — see diff]" : block;
  });

  // Truncate
  if (text.length > 2000) {
    text = text.substring(0, 2000) + "...";
  }

  return text;
}

function buildPrBody(
  analysis: AnalysisResult,
  jiraTicket: string,
  jiraUrl: string,
  sanitizedSamples: string[],
  editCount: number,
  actualFixSummary?: string
): string {
  return `## Summary

Automated fix for error pattern: **${analysis.errorPattern}**

**Jira:** [${jiraTicket}](${jiraUrl})
**Component:** ${analysis.component}
**Category:** ${analysis.category}
**Files edited:** ${editCount}

## Root Cause

${analysis.rootCauseHypothesis}

## Suggested Approach (from analysis)

${analysis.suggestedApproach}

## Fix Applied

${actualFixSummary || "_No fix summary available — see diff._"}

## Log Samples (sanitized)

${sanitizedSamples.map((s, i) => `${i + 1}. ${s}`).join("\n")}

---
_This PR was auto-generated by the Log Monitor pipeline._
_Please review carefully before merging._`;
}
