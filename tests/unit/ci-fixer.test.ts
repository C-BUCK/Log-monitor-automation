import { describe, it, expect, vi } from "vitest";
import { extractFailingStepLog, waitForCi } from "../../src/pipeline/ci-fixer.js";

describe("extractFailingStepLog", () => {
  it("extracts content between group markers for failing step", () => {
    const log = [
      "##[group]Run setup",
      "setup output",
      "##[endgroup]",
      "##[group]Run tests",
      "test output line 1",
      "test output line 2",
      "Error: test failed",
      "##[endgroup]",
      "##[group]Cleanup",
      "cleanup output",
      "##[endgroup]",
    ].join("\n");

    const result = extractFailingStepLog(log, "Run tests");
    expect(result).toContain("test output line 1");
    expect(result).toContain("Error: test failed");
    expect(result).not.toContain("setup output");
    expect(result).not.toContain("cleanup output");
  });

  it("truncates to maxLines keeping the tail", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const log = [
      "##[group]Run tests",
      ...lines,
      "##[endgroup]",
    ].join("\n");

    const result = extractFailingStepLog(log, "Run tests", 200);
    const resultLines = result.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(201);
    expect(result).toContain("line 299");
    expect(result).not.toContain("line 0");
  });

  it("returns full log if step not found", () => {
    const log = "some log output\nmore output";
    const result = extractFailingStepLog(log, "NonexistentStep");
    expect(result).toContain("some log output");
  });

  it("handles empty log", () => {
    const result = extractFailingStepLog("", "Run tests");
    expect(result).toBe("");
  });
});

function makeGithubClient(runs: Array<{ status: string; conclusion: string | null; headSha: string }>) {
  let callIndex = 0;
  return {
    getLatestWorkflowRun: vi.fn().mockImplementation(async () => {
      const run = runs[callIndex++];
      if (!run) return null;
      return { runId: 1, ...run };
    }),
    getFailedJobs: vi.fn().mockResolvedValue([]),
    downloadJobLog: vi.fn().mockResolvedValue(""),
    getPrChecks: vi.fn(),
    getPrState: vi.fn(),
    addPrComment: vi.fn(),
  };
}

describe("waitForCi", () => {
  it("returns 'passing' when CI completes successfully", async () => {
    const gh = makeGithubClient([
      { status: "completed", conclusion: "success", headSha: "abc123" },
    ]);
    const result = await waitForCi(gh as any, "owner", "repo", "branch", "abc123", 10, 5000);
    expect(result).toBe("passing");
  });

  it("returns 'failing' when CI completes with failure", async () => {
    const gh = makeGithubClient([
      { status: "completed", conclusion: "failure", headSha: "abc123" },
    ]);
    const result = await waitForCi(gh as any, "owner", "repo", "branch", "abc123", 10, 5000);
    expect(result).toBe("failing");
  });

  it("returns 'timeout' when deadline reached", async () => {
    const gh = makeGithubClient([
      { status: "in_progress", conclusion: null, headSha: "abc123" },
      { status: "in_progress", conclusion: null, headSha: "abc123" },
    ]);
    const result = await waitForCi(gh as any, "owner", "repo", "branch", "abc123", 10, 50);
    expect(result).toBe("timeout");
  });

  it("ignores stale runs with wrong SHA", async () => {
    const gh = makeGithubClient([
      { status: "completed", conclusion: "failure", headSha: "old-sha" },
      { status: "completed", conclusion: "success", headSha: "abc123" },
    ]);
    const result = await waitForCi(gh as any, "owner", "repo", "branch", "abc123", 10, 5000);
    expect(result).toBe("passing");
  });

  it("keeps polling while status is in_progress then resolves", async () => {
    const gh = makeGithubClient([
      { status: "in_progress", conclusion: null, headSha: "abc123" },
      { status: "completed", conclusion: "success", headSha: "abc123" },
    ]);
    const result = await waitForCi(gh as any, "owner", "repo", "branch", "abc123", 10, 5000);
    expect(result).toBe("passing");
    expect(gh.getLatestWorkflowRun).toHaveBeenCalledTimes(2);
  });
});
