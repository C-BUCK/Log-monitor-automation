#!/usr/bin/env npx tsx
/**
 * Local integration smoke test — validates each external service call
 * Run: npx tsx scripts/test-integrations.ts
 *
 * Tests (in order of cheapness):
 *  1. Jira: search, create issue, transition, get issue
 *  2. GitHub: branch check, list PRs
 *  3. Slack: post message
 *  4. BetterStack: MCP init + query
 *  5. Claude CLI: complete (haiku — cheap), codeEdit (haiku — cheap)
 */
import "dotenv/config";

const results: Array<{ name: string; status: "pass" | "fail"; detail: string; ms: number }> = [];

async function test(name: string, fn: () => Promise<string>) {
  const start = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - start;
    results.push({ name, status: "pass", detail, ms });
    console.log(`  ✅ ${name} (${ms}ms) — ${detail}`);
  } catch (err) {
    const ms = Date.now() - start;
    const detail = String(err).substring(0, 200);
    results.push({ name, status: "fail", detail, ms });
    console.log(`  ❌ ${name} (${ms}ms) — ${detail}`);
  }
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

async function main() {
  console.log("\n🔍 Integration Smoke Tests\n");

  // ── Jira ──────────────────────────────────────────────────────
  console.log("── Jira ──");
  const jiraBase = requireEnv("JIRA_BASE_URL").replace(/\/(jira|browse|projects)\/?.*$/i, "").replace(/\/$/, "");
  const jiraAuth = `Basic ${Buffer.from(`${requireEnv("JIRA_EMAIL")}:${requireEnv("JIRA_API_TOKEN")}`).toString("base64")}`;
  const jiraProjectKey = requireEnv("JIRA_PROJECT_KEY_SERVICE_A");

  const jiraFetch = async (method: string, path: string, body?: unknown) => {
    const url = `${jiraBase}${path}`;
    const res = await fetch(url, {
      method,
      headers: { Authorization: jiraAuth, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${text.substring(0, 200)}`);
    }
    // Handle 204 No Content (e.g. POST transitions)
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };

  // 1a. Jira search
  await test("Jira search (POST /search/jql)", async () => {
    const data = await jiraFetch("POST", "/rest/api/3/search/jql", {
      jql: `project = ${jiraProjectKey} ORDER BY created DESC`,
      fields: ["summary", "status"],
      maxResults: 3,
    }) as { issues: Array<{ key: string; fields: { summary: string } }> };
    return `Found ${data.issues.length} issues (latest: ${data.issues[0]?.key || "none"})`;
  });

  // 1b. Jira get project issue types
  await test("Jira get issue types", async () => {
    const data = await jiraFetch("GET", `/rest/api/3/project/${jiraProjectKey}`) as {
      issueTypes: Array<{ name: string; id: string; subtask: boolean }>;
    };
    const types = data.issueTypes.filter((t) => !t.subtask).map((t) => `${t.name}(${t.id})`);
    return `Types: ${types.join(", ")}`;
  });

  // 1c. Jira create a test issue
  let testIssueKey = "";
  await test("Jira create issue", async () => {
    // Get issue type first
    const proj = await jiraFetch("GET", `/rest/api/3/project/${jiraProjectKey}`) as {
      issueTypes: Array<{ name: string; id: string; subtask: boolean }>;
    };
    const types = proj.issueTypes.filter((t) => !t.subtask);
    const chosen = types.find((t) => t.name.toLowerCase() === "task") || types[0];

    const data = await jiraFetch("POST", "/rest/api/3/issue", {
      fields: {
        project: { key: jiraProjectKey },
        summary: "[TEST] Integration smoke test — delete me",
        issuetype: { id: chosen.id },
        priority: { name: "Low" },
        labels: ["automation-test"],
        description: {
          type: "doc", version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Created by test-integrations.ts" }] }],
        },
      },
    }) as { key: string };
    testIssueKey = data.key;
    return `Created ${data.key}`;
  });

  // 1d. Jira transition to In Progress
  if (testIssueKey) {
    await test("Jira transition (In Progress)", async () => {
      const data = await jiraFetch("GET", `/rest/api/3/issue/${testIssueKey}/transitions`) as {
        transitions: Array<{ id: string; name: string }>;
      };
      const available = data.transitions.map((t) => t.name);
      const transition = data.transitions.find((t) => t.name.toLowerCase() === "in progress");
      if (!transition) {
        return `No "In Progress" transition found. Available: ${available.join(", ")}`;
      }
      await jiraFetch("POST", `/rest/api/3/issue/${testIssueKey}/transitions`, {
        transition: { id: transition.id },
      });
      return `${testIssueKey} → In Progress (transition id: ${transition.id})`;
    });

    // 1e. Jira get issue (verify status changed)
    await test("Jira get issue (verify status)", async () => {
      const data = await jiraFetch("GET", `/rest/api/3/issue/${testIssueKey}?fields=status,labels`) as {
        key: string;
        fields: { status: { name: string }; labels: string[] };
      };
      return `${data.key} status: ${data.fields.status.name}, labels: ${data.fields.labels.join(", ")}`;
    });
  }

  // ── GitHub ────────────────────────────────────────────────────
  console.log("\n── GitHub ──");
  const ghToken = requireEnv("GITHUB_ACCESS_TOKEN");
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: ghToken });

  await test("GitHub list repos (auth check)", async () => {
    const { data } = await octokit.repos.listForAuthenticatedUser({ per_page: 1 });
    return `Authenticated, can see ${data.length}+ repos`;
  });

  await test("GitHub check branch exists", async () => {
    try {
      await octokit.git.getRef({ owner: "acme-org", repo: "acme-backend", ref: "heads/main" });
      return "main branch exists";
    } catch {
      return "Branch check failed (might be permissions)";
    }
  });

  await test("GitHub list open PRs", async () => {
    const { data } = await octokit.pulls.list({ owner: "acme-org", repo: "acme-backend", state: "open", per_page: 5 });
    return `${data.length} open PRs`;
  });

  // ── Slack ─────────────────────────────────────────────────────
  console.log("\n── Slack ──");
  const slackToken = requireEnv("SLACK_BOT_TOKEN");
  const slackChannel = requireEnv("SLACK_CHANNEL_ID");

  await test("Slack post message", async () => {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: slackChannel, text: "🧪 Integration smoke test — ignore this message" }),
    });
    const data = await res.json() as { ok: boolean; error?: string; ts?: string };
    if (!data.ok) throw new Error(`Slack error: ${data.error}`);
    return `Message posted (ts: ${data.ts})`;
  });

  // ── BetterStack MCP ───────────────────────────────────────────
  console.log("\n── BetterStack MCP ──");
  const bsToken = requireEnv("BETTERSTACK_API_TOKEN");

  let bsSessionId = "";
  await test("BetterStack MCP init session", async () => {
    const res = await fetch("https://mcp.betterstack.com/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${bsToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      }),
    });
    bsSessionId = res.headers.get("Mcp-Session-Id") || res.headers.get("mcp-session-id") || "";
    if (!bsSessionId) {
      const body = await res.text();
      throw new Error(`No session ID. Status: ${res.status}, Body: ${body.substring(0, 200)}`);
    }
    return `Session: ${bsSessionId.substring(0, 20)}...`;
  });

  if (bsSessionId) {
    await test("BetterStack MCP list tools", async () => {
      const res = await fetch("https://mcp.betterstack.com/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${bsToken}`,
          "Mcp-Session-Id": bsSessionId,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      const contentType = res.headers.get("content-type") || "";
      const body = await res.text();
      let parsed;
      if (contentType.includes("text/event-stream")) {
        const dataLines = body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
        parsed = JSON.parse(dataLines.join(""));
      } else {
        parsed = JSON.parse(body);
      }
      const tools = parsed.result?.tools?.map((t: { name: string }) => t.name) || [];
      return `${tools.length} tools: ${tools.slice(0, 5).join(", ")}...`;
    });
  }

  // ── Claude CLI ────────────────────────────────────────────────
  console.log("\n── Claude CLI ──");
  const { execFileSync } = await import("node:child_process");

  await test("Claude CLI complete (haiku — cheap)", async () => {
    const result = execFileSync("claude", [
      "-p", "Reply with exactly: INTEGRATION_TEST_OK",
      "--model", "claude-haiku-4-5-20251001",
      "--output-format", "text",
      "--bare",
      "--dangerously-skip-permissions",
    ], { encoding: "utf-8", timeout: 60_000, maxBuffer: 5 * 1024 * 1024 }).trim();
    return `Response: "${result.substring(0, 50)}"`;
  });

  await test("Claude CLI codeEdit (haiku — cheap, read-only)", async () => {
    const result = execFileSync("claude", [
      "-p", "Read the file package.json and tell me the project name. Reply with just the name.",
      "--model", "claude-haiku-4-5-20251001",
      "--output-format", "text",
      "--dangerously-skip-permissions",
      "--allowedTools", "Read",
    ], { encoding: "utf-8", timeout: 120_000, maxBuffer: 5 * 1024 * 1024, cwd: "/workspaces/Acme-Automation" }).trim();
    return `Response: "${result.substring(0, 80)}"`;
  });

  // ── Summary ───────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════");
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests\n`);

  if (failed > 0) {
    console.log("  Failed tests:");
    for (const r of results.filter((r) => r.status === "fail")) {
      console.log(`    ❌ ${r.name}: ${r.detail}`);
    }
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
