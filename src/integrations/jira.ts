// src/integrations/jira.ts
import { logger } from "../utils/logger.js";

const PRIORITY_MAP: Record<string, string> = {
  Critical: "Highest",
  High: "High",
  Medium: "Medium",
  Low: "Low",
};

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;
  private dryRun: boolean;
  private issueTypeCache: Map<string, string> = new Map();

  constructor(baseUrl: string, email: string, apiToken: string, dryRun = false) {
    // Normalize: strip trailing path segments like /jira/ — API needs just the origin
    this.baseUrl = baseUrl.replace(/\/(jira|browse|projects)\/?.*$/i, "").replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
    this.dryRun = dryRun;
  }

  /** Find a valid bug-like issue type for the project (Bug > Task > first available) */
  private async getIssueTypeId(projectKey: string): Promise<string> {
    const cached = this.issueTypeCache.get(projectKey);
    if (cached) return cached;

    try {
      const res = await this.request("GET", `/rest/api/3/project/${projectKey}`);
      const data = (await res.json()) as { issueTypes?: Array<{ id: string; name: string; subtask: boolean }> };
      const types = (data.issueTypes || []).filter((t) => !t.subtask);

      // Prefer Bug, then Task, then whatever exists
      const bug = types.find((t) => t.name.toLowerCase() === "bug");
      const task = types.find((t) => t.name.toLowerCase() === "task");
      const chosen = bug || task || types[0];

      if (chosen) {
        logger.info("Resolved Jira issue type", { projectKey, type: chosen.name, id: chosen.id });
        this.issueTypeCache.set(projectKey, chosen.id);
        return chosen.id;
      }
    } catch (err) {
      logger.warn("Failed to fetch issue types, falling back to name-based", { error: String(err) });
    }

    return ""; // empty — will fall back to name-based
  }

  async createIssue(
    projectKey: string,
    summary: string,
    description: string,
    priority: string,
    labels: string[]
  ): Promise<{ key: string; url: string }> {
    if (this.dryRun) {
      logger.info("[DRY RUN] Would create Jira issue", { projectKey, summary, priority });
      return { key: "DRY-0", url: `${this.baseUrl}/browse/DRY-0` };
    }

    const issueTypeId = await this.getIssueTypeId(projectKey);
    const body = {
      fields: {
        project: { key: projectKey },
        summary,
        issuetype: issueTypeId ? { id: issueTypeId } : { name: "Task" },
        priority: { name: PRIORITY_MAP[priority] || "Medium" },
        labels,
        description: this.toAdf(description),
      },
    };

    const res = await this.request("POST", "/rest/api/3/issue", body);
    const data = (await res.json()) as { key: string };
    return { key: data.key, url: `${this.baseUrl}/browse/${data.key}` };
  }

  async searchIssues(jql: string): Promise<Array<{ key: string; summary: string; status: string }>> {
    // Jira Cloud deprecated GET /search — use POST /search/jql
    const res = await this.request("POST", "/rest/api/3/search/jql", {
      jql,
      fields: ["summary", "status"],
      maxResults: 10,
    });
    const data = (await res.json()) as {
      issues: Array<{
        key: string;
        fields: { summary: string; status: { name: string } };
      }>;
    };
    return data.issues.map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status.name,
    }));
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    if (this.dryRun) {
      logger.info("[DRY RUN] Would add Jira comment", { issueKey });
      return;
    }
    await this.request("POST", `/rest/api/3/issue/${issueKey}/comment`, {
      body: this.toAdf(body),
    });
  }

  /** Transition an issue to a target status (e.g. "In Progress") */
  async transitionTo(issueKey: string, targetStatus: string): Promise<void> {
    if (this.dryRun) {
      logger.info("[DRY RUN] Would transition Jira issue", { issueKey, targetStatus });
      return;
    }

    // Get available transitions
    const res = await this.request("GET", `/rest/api/3/issue/${issueKey}/transitions`);
    const data = (await res.json()) as {
      transitions: Array<{ id: string; name: string }>;
    };

    const transition = data.transitions.find(
      (t) => t.name.toLowerCase() === targetStatus.toLowerCase()
    );
    if (!transition) {
      logger.warn("Jira transition not found", { issueKey, targetStatus, available: data.transitions.map((t) => t.name) });
      return;
    }

    // POST transitions returns 204 No Content — don't parse body
    await this.request("POST", `/rest/api/3/issue/${issueKey}/transitions`, {
      transition: { id: transition.id },
    });
    logger.info("Jira issue transitioned", { issueKey, to: targetStatus });
  }

  async addLabel(issueKey: string, label: string): Promise<void> {
    if (this.dryRun) {
      logger.info("[DRY RUN] Would add Jira label", { issueKey, label });
      return;
    }
    await this.request("PUT", `/rest/api/3/issue/${issueKey}`, {
      update: { labels: [{ add: label }] },
    });
  }

  async getIssue(issueKey: string): Promise<{
    key: string;
    status: string;
    created: string;
    labels: string[];
  }> {
    const res = await this.request(
      "GET",
      `/rest/api/3/issue/${issueKey}?fields=status,created,labels`
    );
    const data = (await res.json()) as {
      key: string;
      fields: {
        status: { name: string };
        created: string;
        labels: string[];
      };
    };
    return {
      key: data.key,
      status: data.fields.status.name,
      created: data.fields.created,
      labels: data.fields.labels,
    };
  }

  /** Check whether an issue still exists (returns false on 404 or network error) */
  async issueExists(issueKey: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/rest/api/3/issue/${issueKey}?fields=status`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Build the browse URL for an issue key */
  getIssueUrl(issueKey: string): string {
    return `${this.baseUrl}/browse/${issueKey}`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info("Jira API request", { method, url, attempt });
        const res = await fetch(url, options);
        if (!res.ok) {
          const text = await res.text();
          // Retry on 5xx server errors or 429 rate limit
          if (attempt < maxRetries && (res.status >= 500 || res.status === 429)) {
            const delay = attempt * 2000;
            logger.warn("Jira API retryable error", { method, url, status: res.status, attempt, retryIn: delay });
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          logger.error("Jira API error", { method, url, status: res.status, body: text.substring(0, 500) });
          throw new Error(`Jira API ${method} ${path} failed (${res.status}): ${text}`);
        }
        return res;
      } catch (err) {
        // Retry on network errors (TypeError: fetch failed)
        if (attempt < maxRetries && err instanceof TypeError) {
          const delay = attempt * 2000;
          logger.warn("Jira API network error, retrying", { method, url, attempt, retryIn: delay, error: String(err) });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Jira API ${method} ${path} failed after ${maxRetries} attempts`);
  }

  private toAdf(text: string): object {
    const paragraphs = text.split(/\n\n+/).map((block) => ({
      type: "paragraph",
      content: [{ type: "text", text: block.replace(/\n/g, " ") }],
    }));
    return {
      type: "doc",
      version: 1,
      content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph", content: [{ type: "text", text: " " }] }],
    };
  }
}
