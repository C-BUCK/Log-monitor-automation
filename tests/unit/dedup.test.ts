// tests/unit/dedup.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deduplicate } from "../../src/pipeline/dedup.js";
import { StateManager } from "../../src/state/manager.js";
import type { ScannedError } from "../../src/types.js";

function makeScanned(overrides: Partial<ScannedError> = {}): ScannedError {
  return {
    pattern: "test_pattern_1",
    service: "backend",
    environment: "production",
    githubRepo: "acme-org/acme-backend",
    occurrenceCount: 10,
    exampleMessage: "some error",
    level: "error",
    component: null,
    firstSeen: "2026-03-20T06:00:00Z",
    lastSeen: "2026-03-20T13:00:00Z",
    rawSamples: ["sample"],
    ...overrides,
  };
}

describe("deduplicate", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-test-"));
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns all errors when state is empty", async () => {
    const errors = [makeScanned(), makeScanned({ pattern: "test_pattern_2" })];
    const result = await deduplicate(errors, stateManager);
    expect(result.newErrors.length).toBe(2);
    expect(result.duplicates.length).toBe(0);
  });

  it("filters out errors with open PRs in state", async () => {
    const state = stateManager.loadErrors();
    state.patterns["backend:production:test_pattern_1"] = {
      status: "active",
      firstSeen: "2026-03-20T06:00:00Z",
      lastSeen: "2026-03-20T10:00:00Z",
      count: 5,
      priority: "Medium",
      prioritySource: "frequency",
      prStatus: "open",
      ciAttempts: 0,
      failureCount: 0,
      slackNotified: false,
    };
    stateManager.saveErrors(state);

    const errors = [makeScanned()];
    const result = await deduplicate(errors, stateManager);
    expect(result.newErrors.length).toBe(0);
    expect(result.duplicates.length).toBe(1);
  });

  it("treats resolved patterns (merged PR) as new", async () => {
    const state = stateManager.loadErrors();
    state.patterns["backend:production:test_pattern_1"] = {
      status: "active",
      firstSeen: "2026-03-19T06:00:00Z",
      lastSeen: "2026-03-19T10:00:00Z",
      count: 5,
      priority: "Medium",
      prioritySource: "frequency",
      prStatus: "merged",
      ciAttempts: 0,
      failureCount: 0,
      slackNotified: true,
    };
    stateManager.saveErrors(state);

    const errors = [makeScanned()];
    const result = await deduplicate(errors, stateManager);
    expect(result.newErrors.length).toBe(1);
  });

  it("updates lastSeen and count for duplicates", async () => {
    const state = stateManager.loadErrors();
    state.patterns["backend:production:test_pattern_1"] = {
      status: "active",
      firstSeen: "2026-03-20T06:00:00Z",
      lastSeen: "2026-03-20T10:00:00Z",
      count: 5,
      priority: "Medium",
      prioritySource: "frequency",
      prStatus: "open",
      ciAttempts: 0,
      failureCount: 0,
      slackNotified: false,
    };
    stateManager.saveErrors(state);

    const errors = [makeScanned({ occurrenceCount: 15, lastSeen: "2026-03-20T14:00:00Z" })];
    await deduplicate(errors, stateManager);

    const updated = stateManager.loadErrors();
    expect(updated.patterns["backend:production:test_pattern_1"].count).toBe(15);
    expect(updated.patterns["backend:production:test_pattern_1"].lastSeen).toBe("2026-03-20T14:00:00Z");
  });

  it("uses Jira search fallback when pattern not in local state", async () => {
    const mockJira = {
      searchIssues: vi.fn().mockResolvedValue([{ key: "PROJ-100", summary: "test", status: "In Progress" }]),
      addComment: vi.fn(),
    };

    const errors = [makeScanned()];
    const result = await deduplicate(errors, stateManager, mockJira as any);
    expect(result.newErrors.length).toBe(0);
    expect(result.duplicates.length).toBe(1);
    expect(mockJira.searchIssues).toHaveBeenCalled();
  });

  it("clears state and treats as new when Jira ticket was deleted externally", async () => {
    const state = stateManager.loadErrors();
    state.patterns["backend:production:test_pattern_1"] = {
      status: "active",
      firstSeen: "2026-03-20T06:00:00Z",
      lastSeen: "2026-03-20T10:00:00Z",
      count: 5,
      priority: "Medium",
      prioritySource: "frequency",
      jiraTicket: "PROJ-999",
      jiraUrl: "https://test.atlassian.net/browse/PROJ-999",
      analysis: { errorPattern: "test_pattern_1" } as any,
      ciAttempts: 1,
      failureCount: 1,
      slackNotified: false,
    };
    stateManager.saveErrors(state);

    const mockJira = {
      searchIssues: vi.fn(),
      addComment: vi.fn(),
      issueExists: vi.fn().mockResolvedValue(false), // ticket was deleted
    };

    const errors = [makeScanned()];
    const result = await deduplicate(errors, stateManager, mockJira as any);

    // Should be treated as new
    expect(result.newErrors.length).toBe(1);
    expect(result.duplicates.length).toBe(0);

    // State should have ticket fields cleared
    const updated = stateManager.loadErrors();
    const entry = updated.patterns["backend:production:test_pattern_1"];
    expect(entry.jiraTicket).toBeUndefined();
    expect(entry.jiraUrl).toBeUndefined();
    expect(entry.analysis).toBeUndefined();
    expect(entry.failureCount).toBe(0);
    expect(entry.ciAttempts).toBe(0);
  });

  it("keeps duplicate when Jira ticket still exists", async () => {
    const state = stateManager.loadErrors();
    state.patterns["backend:production:test_pattern_1"] = {
      status: "active",
      firstSeen: "2026-03-20T06:00:00Z",
      lastSeen: "2026-03-20T10:00:00Z",
      count: 5,
      priority: "Medium",
      prioritySource: "frequency",
      jiraTicket: "PROJ-100",
      ciAttempts: 0,
      failureCount: 0,
      slackNotified: false,
    };
    stateManager.saveErrors(state);

    const mockJira = {
      searchIssues: vi.fn(),
      addComment: vi.fn(),
      issueExists: vi.fn().mockResolvedValue(true), // ticket exists
    };

    const errors = [makeScanned()];
    const result = await deduplicate(errors, stateManager, mockJira as any);
    expect(result.newErrors.length).toBe(0);
    expect(result.duplicates.length).toBe(1);
  });

  it("calls addComment when count has doubled (2x re-eval)", async () => {
    const state = stateManager.loadErrors();
    state.patterns["backend:production:test_pattern_1"] = {
      status: "active",
      firstSeen: "2026-03-20T06:00:00Z",
      lastSeen: "2026-03-20T10:00:00Z",
      count: 10,
      priority: "Medium",
      prioritySource: "frequency",
      jiraTicket: "PROJ-100",
      prStatus: "open",
      ciAttempts: 0,
      failureCount: 0,
      slackNotified: false,
    };
    stateManager.saveErrors(state);

    const mockJira = {
      searchIssues: vi.fn(),
      addComment: vi.fn().mockResolvedValue(undefined),
      issueExists: vi.fn().mockResolvedValue(true),
    };

    // 25 occurrences is more than 2x of previous 10
    const errors = [makeScanned({ occurrenceCount: 25 })];
    await deduplicate(errors, stateManager, mockJira as any);
    expect(mockJira.addComment).toHaveBeenCalledWith("PROJ-100", expect.stringContaining("25"));
  });
});
