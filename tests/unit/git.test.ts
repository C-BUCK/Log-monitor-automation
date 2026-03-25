// tests/unit/git.test.ts
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  git,
  pruneLocalBranches,
  remoteBranchExists,
} from "../../src/utils/git.js";

let tmpDir: string;

function initTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  // Create at least one commit so branch operations work
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(readme, "# Test Repo\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: dir });
  return dir;
}

beforeEach(() => {
  tmpDir = initTestRepo();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("git()", () => {
  it("executes git commands in the specified directory and returns output", () => {
    const result = git(tmpDir, ["status", "--short"]);
    // Should return empty string or valid status output (no error thrown)
    expect(typeof result).toBe("string");
  });

  it("returns the log output for the initial commit", () => {
    const result = git(tmpDir, ["log", "--oneline"]);
    expect(result).toContain("Initial commit");
  });

  it("throws when given an invalid git command", () => {
    expect(() => git(tmpDir, ["not-a-git-subcommand"])).toThrow();
  });
});

describe("pruneLocalBranches()", () => {
  it("deletes local branches matching a prefix", () => {
    // Create a branch with the prefix
    git(tmpDir, ["branch", "fix/test-branch-1"]);
    git(tmpDir, ["branch", "fix/test-branch-2"]);

    pruneLocalBranches(tmpDir, "fix/");

    const branches = git(tmpDir, ["branch", "--list", "fix/*"]);
    expect(branches).toBe("");
  });

  it("handles `*` prefix on current branch without throwing", () => {
    // Create some branches and check that the current branch (with *) is handled
    git(tmpDir, ["branch", "cleanup/feature-a"]);

    // Should not throw even when listing includes the current branch marker
    expect(() => pruneLocalBranches(tmpDir, "cleanup/")).not.toThrow();
  });

  it("does nothing when no branches match the prefix", () => {
    // Should not throw when there are no matching branches
    expect(() => pruneLocalBranches(tmpDir, "nonexistent-prefix/")).not.toThrow();
  });
});

describe("remoteBranchExists()", () => {
  it("returns false when remote does not exist", () => {
    // No remote configured in the test repo, so should return false
    const result = remoteBranchExists(tmpDir, "main");
    expect(result).toBe(false);
  });

  it("returns false on error (e.g., invalid repo path)", () => {
    const result = remoteBranchExists("/nonexistent/path", "main");
    expect(result).toBe(false);
  });
});

