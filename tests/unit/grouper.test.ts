import { describe, it, expect, vi } from "vitest";
import { groupByRootCause } from "../../src/pipeline/grouper.js";
import type { PipelineJob, AnalysisResult, ClassifiedError } from "../../src/types.js";

function makeError(overrides: Partial<ClassifiedError> = {}): ClassifiedError {
  return {
    pattern: "test_pattern",
    service: "backend",
    environment: "production",
    githubRepo: "acme-org/acme-backend",
    occurrenceCount: 10,
    exampleMessage: "test error",
    level: "error",
    component: null,
    firstSeen: "2026-03-20T06:00:00Z",
    lastSeen: "2026-03-20T13:00:00Z",
    rawSamples: ["sample"],
    priority: "High",
    prioritySource: "frequency",
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    errorPattern: "test_pattern",
    service: "backend",
    environment: "production",
    githubRepo: "acme-org/acme-backend",
    component: "fill_pipeline",
    affectedFiles: ["src/fills/processor.rs"],
    relevantLines: "42-50",
    rootCauseHypothesis: "Null check missing",
    suggestedApproach: "Add null check",
    rawLogSamples: ["sample"],
    category: "logic",
    ...overrides,
  };
}

function makeJob(error: Partial<ClassifiedError> = {}, analysis: Partial<AnalysisResult> = {}): PipelineJob {
  return {
    error: makeError(error),
    analysis: makeAnalysis(analysis),
    outcome: "skipped",
  };
}

function makeClaudeClient(responses: string[] = []) {
  let callIndex = 0;
  return {
    complete: vi.fn().mockImplementation(async () => {
      return { text: responses[callIndex++] || "NO" };
    }),
    codeEdit: vi.fn(),
    getCallCount: vi.fn().mockReturnValue(0),
    getTotalCost: vi.fn().mockReturnValue(0),
  };
}

describe("groupByRootCause", () => {
  it("groups jobs with same (service, primaryFile, category)", async () => {
    const jobs = [
      makeJob({ pattern: "err_a", occurrenceCount: 100 }, { errorPattern: "err_a" }),
      makeJob({ pattern: "err_b", occurrenceCount: 50 }, { errorPattern: "err_b" }),
      makeJob({ pattern: "err_c", occurrenceCount: 10 }, { errorPattern: "err_c", affectedFiles: ["src/other.rs"], category: "config" }),
    ];
    const claude = makeClaudeClient();
    const result = await groupByRootCause(jobs, claude as any);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].lead.error.pattern).toBe("err_a");
    expect(result.groups[0].followers).toHaveLength(1);
    expect(result.groups[0].followers[0].error.pattern).toBe("err_b");
    expect(result.ungrouped).toHaveLength(1);
    expect(result.ungrouped[0].error.pattern).toBe("err_c");
  });

  it("selects lead by priority rank then occurrence count", async () => {
    const jobs = [
      makeJob({ pattern: "low_count", priority: "Critical", occurrenceCount: 5 }, { errorPattern: "low_count" }),
      makeJob({ pattern: "high_count", priority: "High", occurrenceCount: 500 }, { errorPattern: "high_count" }),
    ];
    const claude = makeClaudeClient();
    const result = await groupByRootCause(jobs, claude as any);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].lead.error.pattern).toBe("low_count");
  });

  it("skips jobs without analysis", async () => {
    const jobs: PipelineJob[] = [
      makeJob({ pattern: "has_analysis" }),
      { error: makeError({ pattern: "no_analysis" }), outcome: "skipped" },
    ];
    const claude = makeClaudeClient();
    const result = await groupByRootCause(jobs, claude as any);

    expect(result.groups).toHaveLength(0);
    expect(result.ungrouped).toHaveLength(1);
    expect(result.ungrouped[0].error.pattern).toBe("has_analysis");
  });

  it("sorts affectedFiles alphabetically for deterministic grouping", async () => {
    const jobs = [
      makeJob({ pattern: "a" }, { errorPattern: "a", affectedFiles: ["z.rs", "a.rs"] }),
      makeJob({ pattern: "b" }, { errorPattern: "b", affectedFiles: ["a.rs", "z.rs"] }),
    ];
    const claude = makeClaudeClient();
    const result = await groupByRootCause(jobs, claude as any);
    expect(result.groups).toHaveLength(1);
  });
});

describe("Tier 2 fuzzy grouping", () => {
  it("uses Haiku to merge errors with overlapping files in same service", async () => {
    const jobs = [
      makeJob(
        { pattern: "err_x" },
        { errorPattern: "err_x", affectedFiles: ["src/shared.rs", "src/a.rs"], category: "logic" }
      ),
      makeJob(
        { pattern: "err_y" },
        { errorPattern: "err_y", affectedFiles: ["src/shared.rs", "src/b.rs"], category: "config" }
      ),
    ];
    const claude = makeClaudeClient(["YES"]);
    const result = await groupByRootCause(jobs, claude as any);

    expect(result.groups).toHaveLength(1);
    expect(result.ungrouped).toHaveLength(0);
    expect(claude.complete).toHaveBeenCalledTimes(1);
  });

  it("does not merge when Haiku says NO", async () => {
    const jobs = [
      makeJob(
        { pattern: "err_x" },
        { errorPattern: "err_x", affectedFiles: ["src/shared.rs", "src/a.rs"], category: "logic" }
      ),
      makeJob(
        { pattern: "err_y" },
        { errorPattern: "err_y", affectedFiles: ["src/shared.rs", "src/b.rs"], category: "config" }
      ),
    ];
    const claude = makeClaudeClient(["NO"]);
    const result = await groupByRootCause(jobs, claude as any);

    expect(result.groups).toHaveLength(0);
    expect(result.ungrouped).toHaveLength(2);
  });

  it("uses union-find for transitive merges (A~B, B~C -> ABC)", async () => {
    const jobs = [
      makeJob(
        { pattern: "a" },
        { errorPattern: "a", affectedFiles: ["src/shared.rs"], category: "a" }
      ),
      makeJob(
        { pattern: "b" },
        { errorPattern: "b", affectedFiles: ["src/shared.rs", "src/other.rs"], category: "b" }
      ),
      makeJob(
        { pattern: "c" },
        { errorPattern: "c", affectedFiles: ["src/other.rs"], category: "c" }
      ),
    ];
    const claude = makeClaudeClient(["YES", "YES"]);
    const result = await groupByRootCause(jobs, claude as any);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].lead.error.pattern).toBeDefined();
    expect(result.groups[0].followers).toHaveLength(2);
  });

  it("skips cross-service pairs", async () => {
    const jobs = [
      makeJob(
        { pattern: "a", service: "backend" },
        { errorPattern: "a", service: "backend", affectedFiles: ["src/shared.rs"], category: "a" }
      ),
      makeJob(
        { pattern: "b", service: "frontend" },
        { errorPattern: "b", service: "frontend", affectedFiles: ["src/shared.rs"], category: "b" }
      ),
    ];
    const claude = makeClaudeClient();
    const result = await groupByRootCause(jobs, claude as any);

    expect(claude.complete).not.toHaveBeenCalled();
    expect(result.ungrouped).toHaveLength(2);
  });
});
