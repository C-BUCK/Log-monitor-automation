// src/integrations/github.ts
import { Octokit } from "@octokit/rest";
import { Agent } from "node:https";
import { git } from "../utils/git.js";
import { logger } from "../utils/logger.js";

export class GitHubClient {
  private octokit: Octokit;
  private dryRun: boolean;

  constructor(accessToken: string, dryRun = false) {
    // Disable keep-alive to avoid stale sockets after heavy child processes
    // (Claude CLI codeEdit, git push) exhaust or corrupt the connection pool
    const agent = new Agent({ keepAlive: false });
    this.octokit = new Octokit({
      auth: accessToken,
      request: { agent },
    });
    this.dryRun = dryRun;
  }

  /** Retry an async operation on 5xx, network, or connection errors */
  private async withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const status = (err as { status?: number }).status;
        const msg = String(err).toLowerCase();
        const isServerError = status !== undefined && status >= 500;
        const isNetworkError = err instanceof TypeError
          || msg.includes("epipe")
          || msg.includes("other side closed")
          || msg.includes("econnreset")
          || msg.includes("socket hang up")
          || msg.includes("fetch failed");
        if (attempt < maxAttempts && (isServerError || isNetworkError)) {
          const delay = attempt * 3000;
          logger.warn("GitHub API retryable error", { label, status, attempt, retryIn: delay, error: String(err).substring(0, 300) });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`GitHub API ${label} failed after ${maxAttempts} attempts`);
  }

  async branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      await this.octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
      return true;
    } catch { return false; }
  }

  async findPrForBranch(owner: string, repo: string, branch: string): Promise<{ url: string; number: number } | null> {
    const { data } = await this.withRetry("findPrForBranch", () =>
      this.octokit.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: "open" })
    );
    return data.length > 0 ? { url: data[0].html_url, number: data[0].number } : null;
  }

  async createPr(owner: string, repo: string, branch: string, base: string, title: string, body: string): Promise<{ url: string; number: number }> {
    if (this.dryRun) {
      logger.info("[DRY RUN] Would create PR", { owner, repo, branch, title });
      return { url: "https://github.com/dry-run", number: 0 };
    }
    const { data } = await this.withRetry("createPr", () =>
      this.octokit.pulls.create({ owner, repo, head: branch, base, title, body })
    );
    return { url: data.html_url, number: data.number };
  }

  async getPrChecks(owner: string, repo: string, prNumber: number): Promise<"passing" | "failing" | "pending"> {
    const { data: pr } = await this.withRetry("getPrChecks:get", () =>
      this.octokit.pulls.get({ owner, repo, pull_number: prNumber })
    );
    const { data: checks } = await this.withRetry("getPrChecks:checks", () =>
      this.octokit.checks.listForRef({ owner, repo, ref: pr.head.sha })
    );
    if (checks.check_runs.length === 0) return "pending";
    const allComplete = checks.check_runs.every((r) => r.status === "completed");
    if (!allComplete) return "pending";
    const nonFailing = new Set(["success", "skipped", "neutral"]);
    return checks.check_runs.every((r) => r.conclusion && nonFailing.has(r.conclusion)) ? "passing" : "failing";
  }

  async getLatestWorkflowRun(
    owner: string,
    repo: string,
    branch: string
  ): Promise<{ runId: number; conclusion: string | null; status: string; headSha: string } | null> {
    const { data } = await this.withRetry("getLatestWorkflowRun", () =>
      this.octokit.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        branch,
        per_page: 1,
      })
    );
    if (data.workflow_runs.length === 0) return null;
    const run = data.workflow_runs[0];
    return {
      runId: run.id,
      conclusion: run.conclusion,
      status: run.status ?? "",
      headSha: run.head_sha,
    };
  }

  async getFailedJobs(
    owner: string,
    repo: string,
    runId: number
  ): Promise<Array<{ jobId: number; jobName: string; failedStep: string }>> {
    const { data } = await this.withRetry("getFailedJobs", () =>
      this.octokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
      })
    );
    return data.jobs
      .filter((job) => job.conclusion === "failure")
      .map((job) => {
        const failedStep = job.steps?.find((s) => s.conclusion === "failure")?.name || "unknown";
        return { jobId: job.id, jobName: job.name, failedStep };
      });
  }

  async downloadJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    const { data } = await this.withRetry("downloadJobLog", () =>
      this.octokit.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: jobId,
      })
    );
    // Octokit returns the log as a string (it follows the redirect)
    return typeof data === "string" ? data : String(data);
  }

  async getPrState(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<{ state: "open" | "closed"; merged: boolean }> {
    const { data } = await this.withRetry("getPrState", () =>
      this.octokit.pulls.get({ owner, repo, pull_number: prNumber })
    );
    return { state: data.state as "open" | "closed", merged: data.merged };
  }

  async addPrComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    if (this.dryRun) {
      logger.info("[DRY RUN] Would add PR comment", { prNumber });
      return;
    }
    await this.withRetry("addPrComment", () =>
      this.octokit.issues.createComment({ owner, repo, issue_number: prNumber, body })
    );
  }

  /** Convenience: run a git command in a repo directory using safe execFileSync */
  gitExec(repoPath: string, args: string[], timeoutMs = 60000): string {
    return git(repoPath, args, timeoutMs);
  }
}
