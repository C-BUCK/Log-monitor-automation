// src/pipeline/scanner.ts
import type { BetterStackClient } from "../integrations/betterstack.js";
import type { ServiceConfig } from "../config.js";
import type { ScannedError } from "../types.js";
import { logger } from "../utils/logger.js";

export async function scan(
  client: BetterStackClient,
  services: ServiceConfig[]
): Promise<ScannedError[]> {
  await client.initSession();

  const errors: ScannedError[] = [];

  for (const service of services) {
    for (const [env, source] of Object.entries(service.betterstackSources)) {
      if (!source) continue;

      logger.info("Scanning", { service: service.name, environment: env, sourceId: source.sourceId });

      try {
        // Get query instructions (confirms table name)
        const instructions = await client.getQueryInstructions(source.sourceId);
        logger.info("Query instructions", { service: service.name, environment: env, instructions: instructions.substring(0, 500) });

        // Run pattern query (collection = underscore format for SQL FROM, table = dot format for MCP param)
        const patternSql = `SELECT _pattern, count(*) AS cnt, any(JSONExtract(raw, 'message', 'Nullable(String)')) AS example_message, any(JSONExtract(raw, 'level', 'Nullable(String)')) AS level, any(JSONExtract(raw, 'source', 'Nullable(String)')) AS component, min(dt) AS first_seen, max(dt) AS last_seen FROM s3Cluster(primary, ${source.collection}) WHERE _row_type = 1 AND dt > now() - INTERVAL 8 HOUR AND JSONExtract(raw, 'level', 'Nullable(String)') IN ('error', 'warn') GROUP BY _pattern ORDER BY cnt DESC LIMIT 50`;

        const patternResultRaw = await queryWithRetry(client, source.sourceId, patternSql, source.table);
        logger.info("Query result raw", { service: service.name, environment: env, raw: patternResultRaw.substring(0, 500) });
        const patterns = parseQueryResult(patternResultRaw);

        for (const p of patterns) {
          // Fetch raw log samples for each pattern
          const sampleSql = `SELECT JSONExtract(raw, 'message', 'Nullable(String)') AS message FROM s3Cluster(primary, ${source.collection}) WHERE _row_type = 1 AND _pattern = '${escapeClickHouse(p._pattern)}' AND dt > now() - INTERVAL 8 HOUR LIMIT 5`;

          let rawSamples: string[] = [];
          try {
            const samplesRaw = await queryWithRetry(client, source.sourceId, sampleSql, source.table);
            const samplesData = parseQueryResult(samplesRaw);
            rawSamples = samplesData.map((s: Record<string, string>) => s.message || "").filter(Boolean);
          } catch (err) {
            logger.warn("Failed to fetch raw samples", { pattern: p._pattern, error: String(err) });
          }

          errors.push({
            pattern: p._pattern,
            service: service.name,
            environment: env,
            githubRepo: service.githubRepo,
            occurrenceCount: Number(p.cnt) || 0,
            exampleMessage: p.example_message || "",
            level: p.level || "error",
            component: p.component || null,
            firstSeen: p.first_seen || "",
            lastSeen: p.last_seen || "",
            rawSamples,
          });
        }

        logger.info("Scan complete", { service: service.name, environment: env, patternsFound: patterns.length });
      } catch (err) {
        logger.error("Scan failed for source, continuing with remaining sources", { service: service.name, environment: env, error: String(err) });
      }
    }
  }

  return errors;
}

async function queryWithRetry(
  client: BetterStackClient,
  sourceId: number,
  sql: string,
  table: string
): Promise<string> {
  try {
    return await client.query(sourceId, sql, table);
  } catch (err) {
    logger.warn("BetterStack query failed, retrying once", { error: String(err) });
    await new Promise((r) => setTimeout(r, 1000));
    return await client.query(sourceId, sql, table);
  }
}

function parseQueryResult(raw: string): Array<Record<string, string>> {
  // Try JSON first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON — try markdown table format
  }

  // Parse markdown table: "| col1 | col2 |\n| -- | -- |\n| val1 | val2 |"
  const lines = raw.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 3) {
    // Need at least header, separator, and one data row
    if (raw.trim().length > 0 && !raw.includes("Query executed successfully")) {
      logger.warn("Failed to parse BetterStack query result", { raw: raw.substring(0, 200) });
    }
    return [];
  }

  const parseRow = (line: string): string[] =>
    line.split("|").slice(1, -1).map((cell) => cell.trim());

  const headers = parseRow(lines[0]);
  const rows: Array<Record<string, string>> = [];

  // Skip header (index 0) and separator (index 1), parse data rows
  for (let i = 2; i < lines.length; i++) {
    const values = parseRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

function escapeClickHouse(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
