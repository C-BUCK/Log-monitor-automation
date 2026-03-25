// tests/integration/github.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubClient } from "../../src/integrations/github.js";

// Mock Octokit at the module level
const mockGetRef = vi.fn();
const mockPullsList = vi.fn();
const mockPullsCreate = vi.fn();
const mockPullsGet = vi.fn();
const mockChecksListForRef = vi.fn();
const mockIssuesCreateComment = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    git = { getRef: mockGetRef };
    pulls = { list: mockPullsList, create: mockPullsCreate, get: mockPullsGet };
    checks = { listForRef: mockChecksListForRef };
    issues = { createComment: mockIssuesCreateComment };
  },
}));

// Mock the git utility to avoid actual git calls
vi.mock("../../src/utils/git.js", () => ({
  git: vi.fn().mockReturnValue(""),
  resetToLatest: vi.fn(),
  pruneLocalBranches: vi.fn(),
  remoteBranchExists: vi.fn().mockReturnValue(false),
  run: vi.fn().mockReturnValue(""),
}));

describe("GitHubClient integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("branchExists", () => {
    it("returns true when branch exists", async () => {
      mockGetRef.mockResolvedValueOnce({ data: { ref: "refs/heads/fix/test" } });

      const client = new GitHubClient("ghp_test");
      const exists = await client.branchExists("acme-org", "acme-backend", "fix/test");

      expect(exists).toBe(true);
      expect(mockGetRef).toHaveBeenCalledWith({
        owner: "acme-org",
        repo: "acme-backend",
        ref: "heads/fix/test",
      });
    });

    it("returns false when branch does not exist", async () => {
      mockGetRef.mockRejectedValueOnce(new Error("Not Found"));

      const client = new GitHubClient("ghp_test");
      const exists = await client.branchExists("acme-org", "acme-backend", "fix/nonexistent");

      expect(exists).toBe(false);
    });
  });

  describe("createPr", () => {
    it("creates PR with correct params", async () => {
      mockPullsCreate.mockResolvedValueOnce({
        data: { html_url: "https://github.com/acme-org/acme-backend/pull/99", number: 99 },
      });

      const client = new GitHubClient("ghp_test");
      const result = await client.createPr(
        "acme-org",
        "acme-backend",
        "fix/null-pointer-rd42",
        "main",
        "fix: handle null quotes in exit engine",
        "Automated fix for PROJ-42",
      );

      expect(result).toEqual({
        url: "https://github.com/acme-org/acme-backend/pull/99",
        number: 99,
      });
      expect(mockPullsCreate).toHaveBeenCalledWith({
        owner: "acme-org",
        repo: "acme-backend",
        head: "fix/null-pointer-rd42",
        base: "main",
        title: "fix: handle null quotes in exit engine",
        body: "Automated fix for PROJ-42",
      });
    });
  });

  describe("getPrChecks", () => {
    it("returns 'passing' when all checks pass", async () => {
      mockPullsGet.mockResolvedValueOnce({
        data: { head: { sha: "abc123" } },
      });
      mockChecksListForRef.mockResolvedValueOnce({
        data: {
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "success" },
          ],
        },
      });

      const client = new GitHubClient("ghp_test");
      const status = await client.getPrChecks("acme-org", "acme-backend", 99);

      expect(status).toBe("passing");
    });

    it("returns 'failing' when any check fails", async () => {
      mockPullsGet.mockResolvedValueOnce({
        data: { head: { sha: "abc123" } },
      });
      mockChecksListForRef.mockResolvedValueOnce({
        data: {
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "failure" },
          ],
        },
      });

      const client = new GitHubClient("ghp_test");
      const status = await client.getPrChecks("acme-org", "acme-backend", 99);

      expect(status).toBe("failing");
    });

    it("returns 'pending' when checks are still running", async () => {
      mockPullsGet.mockResolvedValueOnce({
        data: { head: { sha: "abc123" } },
      });
      mockChecksListForRef.mockResolvedValueOnce({
        data: {
          check_runs: [
            { status: "in_progress", conclusion: null },
            { status: "completed", conclusion: "success" },
          ],
        },
      });

      const client = new GitHubClient("ghp_test");
      const status = await client.getPrChecks("acme-org", "acme-backend", 99);

      expect(status).toBe("pending");
    });

    it("returns 'pending' when no check runs exist", async () => {
      mockPullsGet.mockResolvedValueOnce({
        data: { head: { sha: "abc123" } },
      });
      mockChecksListForRef.mockResolvedValueOnce({
        data: { check_runs: [] },
      });

      const client = new GitHubClient("ghp_test");
      const status = await client.getPrChecks("acme-org", "acme-backend", 99);

      expect(status).toBe("pending");
    });
  });

  describe("dry-run mode", () => {
    it("skips createPr write operation", async () => {
      const client = new GitHubClient("ghp_test", true);
      const result = await client.createPr(
        "acme-org",
        "acme-backend",
        "fix/test",
        "main",
        "test PR",
        "body",
      );

      expect(result).toEqual({ url: "https://github.com/dry-run", number: 0 });
      expect(mockPullsCreate).not.toHaveBeenCalled();
    });

    it("skips addPrComment write operation", async () => {
      const client = new GitHubClient("ghp_test", true);
      await client.addPrComment("acme-org", "acme-backend", 99, "test comment");

      expect(mockIssuesCreateComment).not.toHaveBeenCalled();
    });

    it("still allows read operations like branchExists", async () => {
      mockGetRef.mockResolvedValueOnce({ data: { ref: "refs/heads/fix/test" } });

      const client = new GitHubClient("ghp_test", true);
      const exists = await client.branchExists("acme-org", "acme-backend", "fix/test");

      expect(exists).toBe(true);
      expect(mockGetRef).toHaveBeenCalled();
    });
  });
});
