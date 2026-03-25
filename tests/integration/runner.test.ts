// tests/integration/runner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../src/config.js";
import type { ClassifiedError, AnalysisResult } from "../../src/types.js";

// --- Mock all external modules ---

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    default: {
      ...actual,
      randomUUID: vi.fn().mockReturnValue("test-run-id-0000"),
    },
  };
});

vi.mock("../../src/utils/lock.js", () => ({
  acquireLock: vi.fn().mockReturnValue({ acquired: true }),
  releaseLock: vi.fn(),
}));

vi.mock("../../src/utils/git.js", () => ({
  git: vi.fn().mockReturnValue(""),
  resetToLatest: vi.fn(),
  pruneLocalBranches: vi.fn(),
  remoteBranchExists: vi.fn().mockReturnValue(false),
  run: vi.fn().mockReturnValue(""),
}));

const mockBetterStackInstance = {
  initSession: vi.fn(),
  getQueryInstructions: vi.fn().mockResolvedValue("ok"),
  query: vi.fn().mockResolvedValue("[]"),
};
vi.mock("../../src/integrations/betterstack.js", () => ({
  BetterStackClient: class {
    initSession = mockBetterStackInstance.initSession;
    getQueryInstructions = mockBetterStackInstance.getQueryInstructions;
    query = mockBetterStackInstance.query;
  },
}));

const mockClaudeInstance = {
  complete: vi.fn().mockResolvedValue({ text: "mock response" }),
  codeEdit: vi.fn().mockResolvedValue({ text: "mock response" }),
  getTotalCost: vi.fn().mockReturnValue(0),
  getCallCount: vi.fn().mockReturnValue(0),
};
vi.mock("../../src/integrations/claude.js", () => ({
  ClaudeClient: class {
    complete = mockClaudeInstance.complete;
    codeEdit = mockClaudeInstance.codeEdit;
    getTotalCost = mockClaudeInstance.getTotalCost;
    getCallCount = mockClaudeInstance.getCallCount;
  },
}));

const mockJiraInstance = {
  createIssue: vi.fn(),
  searchIssues: vi.fn().mockResolvedValue([]),
  addComment: vi.fn(),
  addLabel: vi.fn(),
  getIssue: vi.fn(),
};
vi.mock("../../src/integrations/jira.js", () => ({
  JiraClient: class {
    createIssue = mockJiraInstance.createIssue;
    searchIssues = mockJiraInstance.searchIssues;
    addComment = mockJiraInstance.addComment;
    addLabel = mockJiraInstance.addLabel;
    getIssue = mockJiraInstance.getIssue;
  },
}));

const mockGithubInstance = {
  branchExists: vi.fn().mockResolvedValue(false),
  findPrForBranch: vi.fn().mockResolvedValue(null),
  createPr: vi.fn(),
  getPrChecks: vi.fn().mockResolvedValue("pending"),
  addPrComment: vi.fn(),
  gitExec: vi.fn().mockReturnValue(""),
};
vi.mock("../../src/integrations/github.js", () => ({
  GitHubClient: class {
    branchExists = mockGithubInstance.branchExists;
    findPrForBranch = mockGithubInstance.findPrForBranch;
    createPr = mockGithubInstance.createPr;
    getPrChecks = mockGithubInstance.getPrChecks;
    addPrComment = mockGithubInstance.addPrComment;
    gitExec = mockGithubInstance.gitExec;
  },
}));

vi.mock("../../src/integrations/slack.js", () => ({
  SlackClient: class {
    postMessage = vi.fn().mockResolvedValue(true);
  },
}));

// Pipeline stage mocks
const mockScan = vi.fn();
vi.mock("../../src/pipeline/scanner.js", () => ({
  scan: (...args: unknown[]) => mockScan(...args),
}));

const mockLoadRules = vi.fn().mockReturnValue([]);
const mockClassifyAllAsync = vi.fn();
const mockClassify = vi.fn().mockImplementation((error: unknown) => error);
vi.mock("../../src/pipeline/classifier.js", () => ({
  loadRules: (...args: unknown[]) => mockLoadRules(...args),
  classify: (...args: unknown[]) => mockClassify(...args),
  classifyAllAsync: (...args: unknown[]) => mockClassifyAllAsync(...args),
}));

const mockDeduplicate = vi.fn();
vi.mock("../../src/pipeline/dedup.js", () => ({
  deduplicate: (...args: unknown[]) => mockDeduplicate(...args),
}));

const mockAnalyze = vi.fn();
vi.mock("../../src/pipeline/analyzer.js", () => ({
  analyze: (...args: unknown[]) => mockAnalyze(...args),
}));

const mockCreateTicket = vi.fn();
vi.mock("../../src/pipeline/ticketer.js", () => ({
  createTicket: (...args: unknown[]) => mockCreateTicket(...args),
}));

const mockFix = vi.fn();
vi.mock("../../src/pipeline/fixer.js", () => ({
  fix: (...args: unknown[]) => mockFix(...args),
}));

const mockMonitorCi = vi.fn();
vi.mock("../../src/pipeline/ci-monitor.js", () => ({
  monitorCi: (...args: unknown[]) => mockMonitorCi(...args),
}));

const mockNotify = vi.fn();
vi.mock("../../src/pipeline/notifier.js", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

// --- Helpers ---

function makeError(patternSuffix: string, priority: "Critical" | "High" | "Medium" | "Low" = "High"): ClassifiedError {
  return {
    pattern: `error-pattern-${patternSuffix}`,
    service: "backend",
    environment: "production",
    githubRepo: "acme-org/acme-backend",
    occurrenceCount: 10,
    exampleMessage: `Example of error ${patternSuffix}`,
    level: "error",
    component: null,
    firstSeen: "2026-03-19T00:00:00Z",
    lastSeen: "2026-03-20T00:00:00Z",
    rawSamples: [`sample-${patternSuffix}`],
    priority,
    prioritySource: "rule",
  };
}

function makeAnalysis(patternSuffix: string): AnalysisResult {
  return {
    errorPattern: `error-pattern-${patternSuffix}`,
    service: "backend",
    environment: "production",
    githubRepo: "acme-org/acme-backend",
    component: "exit-engine",
    affectedFiles: [`src/${patternSuffix}/engine.rs`],
    relevantLines: "line 42",
    rootCauseHypothesis: `Null reference in ${patternSuffix}`,
    suggestedApproach: "Add null check",
    rawLogSamples: [`sample-${patternSuffix}`],
    category: `runtime-error-${patternSuffix}`,
  };
}

// --- Test suite ---

describe("Pipeline runner integration", () => {
  let tmpDir: string;
  let mockConfig: AppConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
    // Create repos dir and repo path so existsSync returns true
    const repoPath = path.join(tmpDir, "repos", "acme-backend");
    fs.mkdirSync(repoPath, { recursive: true });

    mockConfig = {
      betterstack: { apiToken: "test-token" },
      jira: { baseUrl: "https://test.atlassian.net", email: "test@test.com", apiToken: "test" },
      github: { accessToken: "ghp_test" },
      slack: { botToken: "xoxb-test", channelId: "C123", webhookUrl: "" },
      anthropic: { apiKey: "sk-ant-test" },
      port: 3000,
      dryRun: false,
      stateDir: tmpDir,
      reposDir: path.join(tmpDir, "repos"),
      pipeline: {
        runSchedule: "0 6,14,22 * * *",
        runTimeoutMinutes: 30,
        maxErrorsPerRun: 10,
        ciMaxFixAttempts: 3,
        maxFileEditsPerFix: 5,
        costAlertThresholdUsd: 20,
        analysisBranch: "main",
        targetBranch: "development",
        staleNeedsHumanDays: 3,
        statePruneAgeDays: 30,
        runHistoryRetentionDays: 90,
      },
      services: [{
        name: "backend",
        betterstackSources: { production: { sourceId: 12345, table: "test_table.logs" } },
        jiraProjectKey: "RD",
        githubRepo: "acme-org/acme-backend",
        repoLocalPath: path.join(tmpDir, "repos", "acme-backend"),
      }],
    };

    // Default happy-path mocks for CI monitor and notify
    mockMonitorCi.mockResolvedValue({
      passed: [],
      failed: [],
      pending: [],
      needsHuman: [],
      staleReminders: [],
      ciFixesAttempted: 0,
      ciFixesPushed: 0,
    });
    mockNotify.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full run with 2 new errors: scan -> dedup -> classify -> analyze -> ticket -> fix -> notify", async () => {
    const error1 = makeError("alpha", "Critical");
    const error2 = makeError("beta", "High");
    const scanned = [
      { ...error1, priority: undefined, prioritySource: undefined },
      { ...error2, priority: undefined, prioritySource: undefined },
    ];

    mockScan.mockResolvedValue(scanned);
    // Dedup now runs BEFORE classification on raw scanned errors
    mockDeduplicate.mockResolvedValue({ newErrors: scanned, duplicates: [] });
    // Classify only receives new (non-duplicated) errors
    mockClassifyAllAsync.mockResolvedValue([error1, error2]);

    const analysis1 = makeAnalysis("alpha");
    const analysis2 = makeAnalysis("beta");
    mockAnalyze
      .mockResolvedValueOnce(analysis1)
      .mockResolvedValueOnce(analysis2);

    mockCreateTicket
      .mockResolvedValueOnce({ key: "PROJ-100", url: "https://test.atlassian.net/browse/PROJ-100", created: true })
      .mockResolvedValueOnce({ key: "PROJ-101", url: "https://test.atlassian.net/browse/PROJ-101", created: true });

    mockFix
      .mockResolvedValueOnce({ outcome: "success", branch: "fix/alpha-rd100", prUrl: "https://github.com/pr/1", prNumber: 1 })
      .mockResolvedValueOnce({ outcome: "success", branch: "fix/beta-rd101", prUrl: "https://github.com/pr/2", prNumber: 2 });

    const { runPipeline } = await import("../../src/pipeline/runner.js");
    const summary = await runPipeline(mockConfig);

    // Verify pipeline stages called
    expect(mockScan).toHaveBeenCalledOnce();
    expect(mockClassifyAllAsync).toHaveBeenCalledOnce();
    expect(mockDeduplicate).toHaveBeenCalledOnce();
    expect(mockAnalyze).toHaveBeenCalledTimes(2);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    expect(mockFix).toHaveBeenCalledTimes(2);
    expect(mockMonitorCi).toHaveBeenCalledOnce();
    expect(mockNotify).toHaveBeenCalledOnce();

    // Verify summary
    expect(summary.status).toBe("completed");
    expect(summary.errorsScanned).toBe(2);
    expect(summary.newErrors).toBe(2);
    expect(summary.prsOpened).toBe(2);
    expect(summary.jobs).toHaveLength(2);
    expect(summary.jobs[0].outcome).toBe("success");
    expect(summary.jobs[0].jiraTicket).toBe("PROJ-100");
    expect(summary.jobs[1].outcome).toBe("success");
    expect(summary.jobs[1].jiraTicket).toBe("PROJ-101");
  });

  it("deferred error from previous run is picked up and processed", async () => {
    // Seed state with a deferred error
    const stateDir = tmpDir;
    const errorState = {
      schemaVersion: 1,
      patterns: {
        "backend:production:deferred-pattern": {
          status: "deferred",
          firstSeen: "2026-03-18T00:00:00Z",
          lastSeen: "2026-03-19T00:00:00Z",
          count: 5,
          priority: "Medium",
          prioritySource: "rule",
          ciAttempts: 0,
          failureCount: 0,
          slackNotified: false,
        },
      },
    };
    fs.writeFileSync(path.join(stateDir, "errors.json"), JSON.stringify(errorState));

    // Scanner returns no new errors
    mockScan.mockResolvedValue([]);
    // Dedup receives empty scanned array, returns nothing new
    mockDeduplicate.mockResolvedValue({ newErrors: [], duplicates: [] });
    // Classify receives empty new errors, returns nothing
    mockClassifyAllAsync.mockResolvedValue([]);
    // Deferred error is loaded from state and merged after classify

    const analysis = makeAnalysis("deferred");
    analysis.errorPattern = "deferred-pattern";
    mockAnalyze.mockResolvedValueOnce(analysis);
    mockCreateTicket.mockResolvedValueOnce({ key: "PROJ-200", url: "https://test.atlassian.net/browse/PROJ-200", created: true });
    mockFix.mockResolvedValueOnce({ outcome: "success", branch: "fix/deferred-rd200", prUrl: "https://github.com/pr/5", prNumber: 5 });

    const { runPipeline } = await import("../../src/pipeline/runner.js");
    const summary = await runPipeline(mockConfig);

    expect(summary.status).toBe("completed");
    // The deferred error should have been processed
    expect(mockAnalyze).toHaveBeenCalledOnce();
    expect(mockCreateTicket).toHaveBeenCalledOnce();
    expect(mockFix).toHaveBeenCalledOnce();
    expect(summary.prsOpened).toBe(1);
    expect(summary.jobs).toHaveLength(1);
    expect(summary.jobs[0].jiraTicket).toBe("PROJ-200");
  });

  it("error isolation: one error failing analysis does not block the other", async () => {
    const error1 = makeError("good", "Critical");
    const error2 = makeError("bad", "High");

    mockScan.mockResolvedValue([error1, error2]);
    mockDeduplicate.mockResolvedValue({ newErrors: [error1, error2], duplicates: [] });
    mockClassifyAllAsync.mockResolvedValue([error1, error2]);

    const analysis1 = makeAnalysis("good");
    mockAnalyze
      .mockResolvedValueOnce(analysis1)
      .mockRejectedValueOnce(new Error("Claude API timeout"));

    mockCreateTicket.mockResolvedValueOnce({ key: "PROJ-300", url: "https://test.atlassian.net/browse/PROJ-300", created: true });
    mockFix.mockResolvedValueOnce({ outcome: "success", branch: "fix/good-rd300", prUrl: "https://github.com/pr/10", prNumber: 10 });

    const { runPipeline } = await import("../../src/pipeline/runner.js");
    const summary = await runPipeline(mockConfig);

    // First error should succeed
    expect(summary.jobs).toHaveLength(2);
    expect(summary.jobs[0].outcome).toBe("success");
    expect(summary.jobs[0].jiraTicket).toBe("PROJ-300");

    // Second error should fail but not crash the run
    expect(summary.jobs[1].outcome).toBe("failed");
    expect(summary.jobs[1].failureReason).toContain("Claude API timeout");

    // Overall run reports failed because one step failed (I16)
    expect(summary.status).toBe("failed");
    expect(summary.prsOpened).toBe(1);
  });

  it("dry-run mode: no external side effects, state still written", async () => {
    mockConfig.dryRun = true;

    const error1 = makeError("dryrun", "Medium");
    mockScan.mockResolvedValue([error1]);
    mockDeduplicate.mockResolvedValue({ newErrors: [error1], duplicates: [] });
    mockClassifyAllAsync.mockResolvedValue([error1]);

    const analysis = makeAnalysis("dryrun");
    mockAnalyze.mockResolvedValueOnce(analysis);
    mockCreateTicket.mockResolvedValueOnce({ key: "PROJ-400", url: "https://test.atlassian.net/browse/PROJ-400", created: true });
    mockFix.mockResolvedValueOnce({ outcome: "success", branch: "fix/dryrun-rd400", prUrl: "https://github.com/pr/20", prNumber: 20 });

    const { runPipeline } = await import("../../src/pipeline/runner.js");
    const summary = await runPipeline(mockConfig);

    expect(summary.status).toBe("completed");
    expect(summary.jobs).toHaveLength(1);

    // State file should exist (run history is written)
    const runsFile = path.join(tmpDir, "runs.json");
    expect(fs.existsSync(runsFile)).toBe(true);
    const runs = JSON.parse(fs.readFileSync(runsFile, "utf-8"));
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0].id).toBe("test-run-id-0000");

    // Error state should also be written
    const errorsFile = path.join(tmpDir, "errors.json");
    expect(fs.existsSync(errorsFile)).toBe(true);
  });
});
