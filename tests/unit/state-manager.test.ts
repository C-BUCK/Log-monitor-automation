// tests/unit/state-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StateManager } from "../../src/state/manager.js";

describe("StateManager", () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-test-"));
    manager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes with empty state when no files exist", () => {
    const state = manager.loadErrors();
    expect(state.schemaVersion).toBe(1);
    expect(Object.keys(state.patterns)).toHaveLength(0);
  });

  it("persists and reloads error state atomically", () => {
    const state = manager.loadErrors();
    state.patterns["backend:production:test_pattern"] = {
      status: "active",
      firstSeen: "2026-03-20T08:00:00Z",
      lastSeen: "2026-03-20T08:00:00Z",
      count: 5,
      priority: "High",
      prioritySource: "frequency",
      ciAttempts: 0,
      failureCount: 0,
      slackNotified: false,
    };
    manager.saveErrors(state);

    const reloaded = manager.loadErrors();
    expect(reloaded.patterns["backend:production:test_pattern"].count).toBe(5);
  });

  it("falls back to empty state on corrupted JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "errors.json"), "NOT JSON{{{");
    const state = manager.loadErrors();
    expect(state.schemaVersion).toBe(1);
    expect(Object.keys(state.patterns)).toHaveLength(0);
  });

  it("prunes merged entries older than pruneAgeDays", () => {
    const state = manager.loadErrors();
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    state.patterns["old:prod:pattern1"] = {
      status: "active",
      firstSeen: oldDate,
      lastSeen: oldDate,
      count: 1,
      priority: "Low",
      prioritySource: "frequency",
      prStatus: "merged",
      ciAttempts: 0,
      failureCount: 0,
      slackNotified: true,
    };
    state.patterns["recent:prod:pattern2"] = {
      status: "active",
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      count: 1,
      priority: "Low",
      prioritySource: "frequency",
      ciAttempts: 0,
      failureCount: 0,
      slackNotified: false,
    };
    manager.saveErrors(state);

    manager.pruneErrors(30);
    const pruned = manager.loadErrors();
    expect(pruned.patterns["old:prod:pattern1"]).toBeUndefined();
    expect(pruned.patterns["recent:prod:pattern2"]).toBeDefined();
  });

  it("migrates old schema version to current", () => {
    const oldState = {
      schemaVersion: 0,
      patterns: {
        "test:prod:p1": {
          status: "active",
          firstSeen: "2026-03-20T00:00:00Z",
          lastSeen: "2026-03-20T00:00:00Z",
          count: 1,
          priority: "Low",
          prioritySource: "frequency",
          ciAttempts: 0,
          slackNotified: false,
        },
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "errors.json"),
      JSON.stringify(oldState)
    );

    const state = manager.loadErrors();
    expect(state.schemaVersion).toBe(1);
    expect(state.patterns["test:prod:p1"].failureCount).toBe(0);
  });
});
