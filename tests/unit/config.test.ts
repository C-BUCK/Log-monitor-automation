// tests/unit/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BETTERSTACK_API_TOKEN: "test-bs-token",
      JIRA_BASE_URL: "https://test.atlassian.net",
      JIRA_EMAIL: "test@example.com",
      JIRA_API_TOKEN: "test-jira-token",
      JIRA_PROJECT_KEY_SERVICE_A: "RD",
      JIRA_PROJECT_KEY_SERVICE_B: "SS",
      GITHUB_ACCESS_TOKEN: "ghp_test",
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_CHANNEL_ID: "C12345",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/test",
      ANTHROPIC_API_KEY: "sk-ant-test",
      STATE_DIR: "/tmp/test-state",
      REPOS_DIR: "/tmp/test-repos",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads all required environment variables", () => {
    const config = loadConfig();
    expect(config.betterstack.apiToken).toBe("test-bs-token");
    expect(config.jira.baseUrl).toBe("https://test.atlassian.net");
    expect(config.github.accessToken).toBe("ghp_test");
    expect(config.anthropic.apiKey).toBe("sk-ant-test");
  });

  it("uses default pipeline settings when not overridden", () => {
    const config = loadConfig();
    expect(config.pipeline.maxErrorsPerRun).toBe(10);
    expect(config.pipeline.runTimeoutMinutes).toBe(60);
    expect(config.pipeline.ciMaxFixAttempts).toBe(3);
    expect(config.pipeline.analysisBranch).toBe("main");
    expect(config.pipeline.targetBranch).toBe("development");
  });

  it("throws if required env var is missing", () => {
    delete process.env.BETTERSTACK_API_TOKEN;
    expect(() => loadConfig()).toThrow();
  });

  it("loads service definitions with correct repo mappings", () => {
    const config = loadConfig();
    const backend = config.services.find((s) => s.name === "backend");
    expect(backend?.githubRepo).toBe("acme-org/acme-backend");
    expect(backend?.jiraProjectKey).toBe("RD");
  });

  it("parses DRY_RUN flag correctly", () => {
    process.env.DRY_RUN = "true";
    const config = loadConfig();
    expect(config.dryRun).toBe(true);
  });

  it("includes CI retry config defaults", () => {
    const config = loadConfig();
    expect(config.pipeline.ciRetryBudgetMinutes).toBe(20);
    expect(config.pipeline.ciPollIntervalMs).toBe(30_000);
    expect(config.pipeline.ciPollTimeoutMs).toBe(600_000);
    expect(config.pipeline.runTimeoutMinutes).toBe(60);
  });
});
