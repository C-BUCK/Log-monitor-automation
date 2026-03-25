// src/state/manager.ts
import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger.js";
import {
  type ErrorState,
  type RunState,
  type RunEntry,
  CURRENT_ERROR_SCHEMA_VERSION,
  CURRENT_RUN_SCHEMA_VERSION,
} from "./types.js";

export class StateManager {
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
  }

  loadErrors(): ErrorState {
    const filePath = path.join(this.stateDir, "errors.json");
    const raw = this.readJsonFile(filePath);
    if (!raw) return this.emptyErrorState();

    const state = raw as ErrorState;
    if (!state.schemaVersion || state.schemaVersion < CURRENT_ERROR_SCHEMA_VERSION) {
      return this.migrateErrorState(state);
    }
    return state;
  }

  saveErrors(state: ErrorState): void {
    const filePath = path.join(this.stateDir, "errors.json");
    this.writeJsonFile(filePath, state);
  }

  pruneErrors(pruneAgeDays: number): void {
    const state = this.loadErrors();
    const cutoff = Date.now() - pruneAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    for (const [key, entry] of Object.entries(state.patterns)) {
      const lastSeen = new Date(entry.lastSeen).getTime();
      if (lastSeen < cutoff && (entry.prStatus === "merged" || entry.prStatus === "closed")) {
        delete state.patterns[key];
        pruned++;
      }
    }

    if (pruned > 0) {
      logger.info("Pruned stale error entries", { pruned });
      this.saveErrors(state);
    }
  }

  loadRuns(): RunState {
    const filePath = path.join(this.stateDir, "runs.json");
    const raw = this.readJsonFile(filePath);
    if (!raw) return { schemaVersion: CURRENT_RUN_SCHEMA_VERSION, runs: [] };
    return raw as RunState;
  }

  appendRun(entry: RunEntry): void {
    const state = this.loadRuns();
    state.runs.push(entry);
    const filePath = path.join(this.stateDir, "runs.json");
    this.writeJsonFile(filePath, state);
  }

  pruneRuns(retentionDays: number): void {
    const state = this.loadRuns();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const before = state.runs.length;
    state.runs = state.runs.filter(
      (r) => new Date(r.startedAt).getTime() >= cutoff
    );
    if (state.runs.length < before) {
      logger.info("Pruned old run entries", { pruned: before - state.runs.length });
      const filePath = path.join(this.stateDir, "runs.json");
      this.writeJsonFile(filePath, state);
    }
  }

  getLastCompletedRun(): RunEntry | null {
    const state = this.loadRuns();
    const completed = state.runs.filter((r) => r.status === "completed");
    return completed.length > 0 ? completed[completed.length - 1] : null;
  }

  getConsecutiveFailures(): number {
    const state = this.loadRuns();
    let count = 0;
    for (let i = state.runs.length - 1; i >= 0; i--) {
      if (state.runs[i].status === "failed") count++;
      else break;
    }
    return count;
  }

  private emptyErrorState(): ErrorState {
    return { schemaVersion: CURRENT_ERROR_SCHEMA_VERSION, patterns: {} };
  }

  private migrateErrorState(state: Partial<ErrorState>): ErrorState {
    logger.info("Migrating error state", {
      from: state.schemaVersion ?? 0,
      to: CURRENT_ERROR_SCHEMA_VERSION,
    });

    const patterns = state.patterns ?? {};
    for (const entry of Object.values(patterns)) {
      if (entry.failureCount === undefined) entry.failureCount = 0;
      if (entry.status === undefined) (entry as unknown as Record<string, unknown>).status = "active";
    }

    return { schemaVersion: CURRENT_ERROR_SCHEMA_VERSION, patterns };
  }

  private readJsonFile(filePath: string): unknown | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    } catch {
      logger.warn("Corrupted state file, falling back to empty", { filePath });
      return null;
    }
  }

  private writeJsonFile(filePath: string, data: unknown): void {
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
  }
}
