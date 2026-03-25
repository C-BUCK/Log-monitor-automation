// tests/integration/jira.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JiraClient } from "../../src/integrations/jira.js";

const BASE_URL = "https://test.atlassian.net";
const EMAIL = "test@example.com";
const API_TOKEN = "jira-token-123";

function authHeader() {
  return `Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64")}`;
}

/** Mock response for GET /project/RD returning available issue types */
function projectMetaResponse() {
  return {
    ok: true,
    json: async () => ({
      issueTypes: [
        { id: "10001", name: "Bug", subtask: false },
        { id: "10002", name: "Task", subtask: false },
        { id: "10003", name: "Sub-task", subtask: true },
      ],
    }),
  };
}

describe("JiraClient integration", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("createIssue", () => {
    it("sends correct ADF body with priority mapping", async () => {
      // First call: getIssueTypeId -> GET /project/RD
      fetchSpy.mockResolvedValueOnce(projectMetaResponse());
      // Second call: POST /issue
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: "PROJ-42" }),
      });

      const client = new JiraClient(BASE_URL, EMAIL, API_TOKEN);
      const result = await client.createIssue(
        "RD",
        "Null pointer in exit engine",
        "The exit engine crashes on null quotes",
        "Critical",
        ["auto-detected", "pipeline"],
      );

      expect(result).toEqual({
        key: "PROJ-42",
        url: "https://test.atlassian.net/browse/PROJ-42",
      });

      // Second call is the create
      const [url, options] = fetchSpy.mock.calls[1];
      expect(url).toBe("https://test.atlassian.net/rest/api/3/issue");
      expect(options.method).toBe("POST");
      expect(options.headers.Authorization).toBe(authHeader());

      const body = JSON.parse(options.body);
      expect(body.fields.project).toEqual({ key: "RD" });
      expect(body.fields.summary).toBe("Null pointer in exit engine");
      // Uses resolved ID, not name
      expect(body.fields.issuetype).toEqual({ id: "10001" });
      // Critical maps to Highest
      expect(body.fields.priority).toEqual({ name: "Highest" });
      expect(body.fields.labels).toEqual(["auto-detected", "pipeline"]);
      // ADF format
      expect(body.fields.description).toEqual({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "The exit engine crashes on null quotes" }],
          },
        ],
      });
    });

    it("maps High priority correctly", async () => {
      fetchSpy.mockResolvedValueOnce(projectMetaResponse());
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: "PROJ-43" }),
      });

      const client = new JiraClient(BASE_URL, EMAIL, API_TOKEN);
      await client.createIssue("RD", "Test", "desc", "High", []);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.fields.priority).toEqual({ name: "High" });
    });

    it("defaults unmapped priority to Medium", async () => {
      fetchSpy.mockResolvedValueOnce(projectMetaResponse());
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: "PROJ-44" }),
      });

      const client = new JiraClient(BASE_URL, EMAIL, API_TOKEN);
      await client.createIssue("RD", "Test", "desc", "Unknown", []);

      const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(body.fields.priority).toEqual({ name: "Medium" });
    });
  });

  describe("searchIssues", () => {
    it("returns matching issues by JQL (POST /search/jql)", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [
            {
              key: "PROJ-10",
              fields: {
                summary: "Error in broker connection",
                status: { name: "Open" },
              },
            },
            {
              key: "PROJ-11",
              fields: {
                summary: "Timeout in SSE listener",
                status: { name: "In Progress" },
              },
            },
          ],
        }),
      });

      const client = new JiraClient(BASE_URL, EMAIL, API_TOKEN);
      const jql = 'project = RD AND labels = "auto-detected"';
      const results = await client.searchIssues(jql);

      expect(results).toEqual([
        { key: "PROJ-10", summary: "Error in broker connection", status: "Open" },
        { key: "PROJ-11", summary: "Timeout in SSE listener", status: "In Progress" },
      ]);

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://test.atlassian.net/rest/api/3/search/jql");
      expect(options.method).toBe("POST");
      const body = JSON.parse(options.body);
      expect(body.jql).toBe(jql);
      expect(body.fields).toEqual(["summary", "status"]);
    });
  });

  describe("addComment", () => {
    it("calls the correct endpoint with ADF body", async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const client = new JiraClient(BASE_URL, EMAIL, API_TOKEN);
      await client.addComment("PROJ-42", "Fix deployed in PR #123");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://test.atlassian.net/rest/api/3/issue/PROJ-42/comment");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body);
      expect(body.body).toEqual({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Fix deployed in PR #123" }],
          },
        ],
      });
    });
  });

  describe("dry-run mode", () => {
    it("skips all API calls for createIssue", async () => {
      const client = new JiraClient(BASE_URL, EMAIL, API_TOKEN, true);
      const result = await client.createIssue("RD", "Test", "desc", "High", ["auto-detected"]);

      expect(result).toEqual({ key: "DRY-0", url: "https://test.atlassian.net/browse/DRY-0" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("skips all API calls for addComment", async () => {
      const client = new JiraClient(BASE_URL, EMAIL, API_TOKEN, true);
      await client.addComment("PROJ-42", "test comment");

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("skips all API calls for addLabel", async () => {
      const client = new JiraClient(BASE_URL, EMAIL, API_TOKEN, true);
      await client.addLabel("PROJ-42", "test-label");

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
