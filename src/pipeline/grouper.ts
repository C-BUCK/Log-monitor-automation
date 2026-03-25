// src/pipeline/grouper.ts
import type { PipelineJob } from "../types.js";
import type { ClaudeClient } from "../integrations/claude.js";
import { logger } from "../utils/logger.js";

export interface ErrorGroup {
  lead: PipelineJob;
  followers: PipelineJob[];
}

export interface GroupResult {
  groups: ErrorGroup[];
  ungrouped: PipelineJob[];
}

const PRIORITY_RANK: Record<string, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Skip: 4,
};

function getPrimaryFile(job: PipelineJob): string {
  const files = [...(job.analysis?.affectedFiles || [])].sort();
  return files[0] || "";
}

function groupKey(job: PipelineJob): string {
  const a = job.analysis!;
  return `${a.service}|${getPrimaryFile(job)}|${a.category}`;
}

function selectLead(jobs: PipelineJob[]): { lead: PipelineJob; followers: PipelineJob[] } {
  const sorted = [...jobs].sort((a, b) => {
    const rankDiff = (PRIORITY_RANK[a.error.priority] ?? 4) - (PRIORITY_RANK[b.error.priority] ?? 4);
    if (rankDiff !== 0) return rankDiff;
    return b.error.occurrenceCount - a.error.occurrenceCount;
  });
  return { lead: sorted[0], followers: sorted.slice(1) };
}

// --- Union-Find for Tier 2 ---
class UnionFind {
  private parent: Map<number, number> = new Map();
  private rank: Map<number, number> = new Map();

  find(x: number): number {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    const rankX = this.rank.get(rx) || 0;
    const rankY = this.rank.get(ry) || 0;
    if (rankX < rankY) { this.parent.set(rx, ry); }
    else if (rankX > rankY) { this.parent.set(ry, rx); }
    else { this.parent.set(ry, rx); this.rank.set(rx, rankX + 1); }
  }
}

function hasOverlappingFiles(a: PipelineJob, b: PipelineJob): boolean {
  const filesA = new Set(a.analysis?.affectedFiles || []);
  return (b.analysis?.affectedFiles || []).some((f) => filesA.has(f));
}

export async function groupByRootCause(
  jobs: PipelineJob[],
  claudeClient: ClaudeClient,
): Promise<GroupResult> {
  const withAnalysis = jobs.filter((j) => j.analysis);

  if (withAnalysis.length === 0) {
    return { groups: [], ungrouped: [] };
  }

  // --- Tier 1: Deterministic grouping by (service, primaryFile, category) ---
  const tier1Map = new Map<string, PipelineJob[]>();
  for (const job of withAnalysis) {
    const key = groupKey(job);
    if (!tier1Map.has(key)) tier1Map.set(key, []);
    tier1Map.get(key)!.push(job);
  }

  const groups: ErrorGroup[] = [];
  const ungroupedAfterTier1: PipelineJob[] = [];

  for (const [, members] of tier1Map) {
    if (members.length >= 2) {
      groups.push(selectLead(members));
    } else {
      ungroupedAfterTier1.push(members[0]);
    }
  }

  logger.info("Tier 1 grouping complete", {
    groupsFormed: groups.length,
    ungrouped: ungroupedAfterTier1.length,
  });

  if (ungroupedAfterTier1.length < 2) {
    return { groups, ungrouped: ungroupedAfterTier1 };
  }

  // --- Tier 2: Haiku-assisted fuzzy grouping ---
  const candidates: Array<[number, number]> = [];
  for (let i = 0; i < ungroupedAfterTier1.length; i++) {
    for (let j = i + 1; j < ungroupedAfterTier1.length; j++) {
      const a = ungroupedAfterTier1[i];
      const b = ungroupedAfterTier1[j];
      if (a.analysis!.service !== b.analysis!.service) continue;
      if (hasOverlappingFiles(a, b)) {
        candidates.push([i, j]);
      }
    }
  }

  if (candidates.length === 0) {
    return { groups, ungrouped: ungroupedAfterTier1 };
  }

  logger.info("Tier 2 fuzzy grouping", { candidatePairs: candidates.length });

  const uf = new UnionFind();
  for (const [i, j] of candidates) {
    const a = ungroupedAfterTier1[i];
    const b = ungroupedAfterTier1[j];
    try {
      const prompt = `You are comparing two production error analyses to determine if they share the same root cause.

Error A:
- Pattern: ${a.analysis!.errorPattern}
- Affected files: ${a.analysis!.affectedFiles.join(", ")}
- Root cause: ${a.analysis!.rootCauseHypothesis}

Error B:
- Pattern: ${b.analysis!.errorPattern}
- Affected files: ${b.analysis!.affectedFiles.join(", ")}
- Root cause: ${b.analysis!.rootCauseHypothesis}

Do these errors share the same root cause and would be fixed by the same code change?
Respond with ONLY "YES" or "NO".`;

      const response = await claudeClient.complete("haiku", "", prompt, 10);
      if (response.text.trim().toUpperCase().startsWith("YES")) {
        uf.union(i, j);
      }
    } catch (err) {
      logger.warn("Tier 2 Haiku call failed, skipping pair", { error: String(err) });
    }
  }

  const tier2Groups = new Map<number, PipelineJob[]>();
  for (let i = 0; i < ungroupedAfterTier1.length; i++) {
    const root = uf.find(i);
    if (!tier2Groups.has(root)) tier2Groups.set(root, []);
    tier2Groups.get(root)!.push(ungroupedAfterTier1[i]);
  }

  const finalUngrouped: PipelineJob[] = [];
  for (const [, members] of tier2Groups) {
    if (members.length >= 2) {
      groups.push(selectLead(members));
    } else {
      finalUngrouped.push(members[0]);
    }
  }

  logger.info("Tier 2 grouping complete", {
    newGroups: groups.length,
    finalUngrouped: finalUngrouped.length,
  });

  return { groups, ungrouped: finalUngrouped };
}
