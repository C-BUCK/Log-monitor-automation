// tests/unit/notifier.test.ts
import { describe, it, expect } from "vitest";
import { formatDigest } from "../../src/pipeline/notifier.js";
import type { RunSummary, PipelineJob, ClassifiedError } from "../../src/types.js";

function makeJob(overrides: Partial<PipelineJob> = {}): PipelineJob {
  return {
    error: {
      pattern: "test pattern",
      service: "backend",
      environment: "production",
      githubRepo: "acme-org/acme-backend",
      occurrenceCount: 10,
      exampleMessage: "test error",
      level: "error",
      component: null,
      firstSeen: "2026-03-20T06:00:00Z",
      lastSeen: "2026-03-20T13:00:00Z",
      rawSamples: [],
      priority: "High",
      prioritySource: "frequency",
    },
    outcome: "success",
    jiraTicket: "PROJ-100",
    prUrl: "https://github.com/test/pr/1",
    prNumber: 1,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-1",
    startedAt: "2026-03-20T14:00:00Z",
    completedAt: "2026-03-20T14:05:00Z",
    status: "completed",
    errorsScanned: 12,
    newErrors: 2,
    deduplicatedErrors: 10,
    deferredErrors: 0,
    prsOpened: 2,
    ciPassed: 1,
    ciFailed: 0,
    costEstimateUsd: 0.45,
    failedSteps: [],
    jobs: [makeJob()],
    ...overrides,
  };
}

describe("formatDigest", () => {
  it("formats a complete run digest", () => {
    const digest = formatDigest(makeSummary(), [], 0, 20);
    expect(digest).toContain("Log Monitor Run");
    expect(digest).toContain("Errors found: 12");
    expect(digest).toContain("New: 2");
    expect(digest).toContain("$0.45");
  });

  it("shows all clear when no new errors", () => {
    const digest = formatDigest(
      makeSummary({ newErrors: 0, jobs: [], prsOpened: 0 }),
      [],
      0,
      20
    );
    expect(digest).toContain("All clear");
  });

  it("includes stale needs-human reminders", () => {
    const staleReminders = [{ key: "backend:prod:p1", jiraTicket: "PROJ-50", daysSinceCreated: 5 }];
    const digest = formatDigest(makeSummary(), staleReminders, 0, 20);
    expect(digest).toContain("PROJ-50");
    expect(digest).toContain("5 days");
  });

  it("includes cost alert when over threshold", () => {
    const digest = formatDigest(makeSummary({ costEstimateUsd: 25 }), [], 0, 20);
    expect(digest).toContain("Cost alert");
  });

  it("includes @channel escalation for consecutive failures", () => {
    const digest = formatDigest(makeSummary(), [], 3, 20);
    expect(digest).toContain("@channel");
  });

  it("includes grouping info when groups are formed", () => {
    const summary = makeSummary({
      groupsFormed: 3,
      followersSkipped: 8,
    });
    const digest = formatDigest(summary, [], 0, 20);
    expect(digest).toContain("3 groups");
    expect(digest).toContain("8 duplicate");
  });

  it("includes CI fix info when attempts were made", () => {
    const summary = makeSummary({
      ciFixesAttempted: 5,
      ciFixesPushed: 3,
    });
    const digest = formatDigest(summary, [], 0, 20);
    expect(digest).toContain("CI fixes");
    expect(digest).toContain("5 attempted");
  });
});
