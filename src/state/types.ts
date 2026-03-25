// src/state/types.ts

import type { AnalysisResult } from "../types.js";

export interface ErrorEntry {
  status: "active" | "deferred" | "abandoned" | "resolved";
  firstSeen: string;
  lastSeen: string;
  count: number;
  priority: string;
  prioritySource: string;
  jiraTicket?: string;
  jiraUrl?: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  prStatus?: "open" | "merged" | "closed" | "not-needed";
  ciStatus?: "pending" | "passing" | "failing" | "fix-pushed" | "needs-human";
  ciAttempts: number;
  failureCount: number;
  lastAttempt?: string;
  slackNotified: boolean;
  analysis?: AnalysisResult;
  groupLeadKey?: string;
}

export interface ErrorState {
  schemaVersion: number;
  patterns: Record<string, ErrorEntry>;
}

export interface RunEntry {
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
  groupsFormed?: number;
  followersSkipped?: number;
  ciFixesAttempted?: number;
  ciFixesPushed?: number;
}

export interface RunState {
  schemaVersion: number;
  runs: RunEntry[];
}

export const CURRENT_ERROR_SCHEMA_VERSION = 1;
export const CURRENT_RUN_SCHEMA_VERSION = 1;
