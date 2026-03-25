// src/types.ts

// --- Scanner output ---
export interface ScannedError {
  pattern: string;
  service: string;
  environment: string;
  githubRepo: string;
  occurrenceCount: number;
  exampleMessage: string;
  level: string;
  component: string | null;
  firstSeen: string;
  lastSeen: string;
  rawSamples: string[];
}

// --- Classifier output ---
export type Priority = "Critical" | "High" | "Medium" | "Low" | "Skip";
export type PrioritySource = "rule" | "frequency" | "haiku";

export interface ClassifiedError extends ScannedError {
  priority: Priority;
  prioritySource: PrioritySource;
}

// --- Analyzer output ---
export interface AnalysisResult {
  errorPattern: string;
  service: string;
  environment: string;
  githubRepo: string;
  component: string;
  affectedFiles: string[];
  relevantLines: string;
  rootCauseHypothesis: string;
  suggestedApproach: string;
  rawLogSamples: string[];
  category: string;
}

// --- Classification rule ---
export interface ClassificationRule {
  pattern: string;
  priority: Priority;
}

// --- Pipeline job (tracks one error through the pipeline) ---
export interface PipelineJob {
  error: ClassifiedError;
  analysis?: AnalysisResult;
  jiraTicket?: string;
  jiraUrl?: string;
  ticketCreated?: boolean;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  outcome: "success" | "failed" | "needs-human" | "skipped" | "already-fixed";
  failureReason?: string;
}

// --- Run summary ---
export interface RunSummary {
  id: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "failed";
  errorsScanned: number;
  newErrors: number;
  deduplicatedErrors: number;
  deferredErrors: number;
  prsOpened: number;
  ciPassed: number;
  ciFailed: number;
  costEstimateUsd: number;
  failedSteps: string[];
  jobs: PipelineJob[];
  groupsFormed?: number;
  followersSkipped?: number;
  ciFixesAttempted?: number;
  ciFixesPushed?: number;
}

// --- Claude model selection ---
export type ClaudeModel = "haiku" | "sonnet" | "opus";
