// src/utils/git.ts
import { execFileSync } from "node:child_process";
import { logger } from "./logger.js";

/**
 * Run a git command safely using execFileSync (no shell injection).
 * Pass git subcommand and args as an array.
 */
export function git(repoPath: string, args: string[], timeoutMs = 60000): string {
  logger.debug("Git exec", { repoPath, args });
  return execFileSync("git", args, {
    cwd: repoPath,
    timeout: timeoutMs,
    encoding: "utf-8",
  }).trim();
}

/**
 * Run a shell command safely via execFileSync with explicit args.
 * Only use for known commands with safe, controlled arguments.
 */
export function run(command: string, args: string[], cwd: string, timeoutMs = 60000): string {
  logger.debug("Shell exec", { command, args, cwd });
  return execFileSync(command, args, {
    cwd,
    timeout: timeoutMs,
    encoding: "utf-8",
  }).trim();
}

/** Fetch and reset to latest target branch, cleaning any leftover changes */
export function resetToLatest(repoPath: string, branch: string): void {
  git(repoPath, ["fetch", "origin"]);
  // Unstage + discard all changes so checkout can switch branches cleanly
  try { git(repoPath, ["reset", "HEAD"]); } catch (err) { logger.warn("git reset HEAD failed (may be empty repo)", { repoPath, error: String(err) }); }
  git(repoPath, ["checkout", "--", "."]);
  git(repoPath, ["clean", "-fd"]);
  git(repoPath, ["checkout", branch]);
  // Hard reset clears any remaining state and syncs with remote
  git(repoPath, ["reset", "--hard", `origin/${branch}`]);
  git(repoPath, ["clean", "-fd"]);
}

/** Delete local branches matching a prefix */
export function pruneLocalBranches(repoPath: string, prefix: string): void {
  const branches = git(repoPath, ["branch", "--list", `${prefix}*`]);
  for (const branch of branches.split("\n").filter(Boolean)) {
    const name = branch.trim().replace(/^\*\s*/, "");
    if (name) {
      try {
        git(repoPath, ["branch", "-D", name]);
      } catch (err) {
        logger.warn("Failed to delete local branch", { branch: name, error: String(err) });
      }
    }
  }
}

/** Check if a branch exists on the remote */
export function remoteBranchExists(repoPath: string, branch: string): boolean {
  try {
    const result = git(repoPath, ["ls-remote", "--heads", "origin", branch]);
    return result.length > 0;
  } catch {
    return false;
  }
}
