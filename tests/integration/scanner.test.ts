// tests/integration/scanner.test.ts
import { describe, it, expect, vi } from "vitest";
import { scan } from "../../src/pipeline/scanner.js";
import type { ServiceConfig } from "../../src/config.js";
import fixture from "../fixtures/betterstack-responses.json";

// Create a mock BetterStack client
function createMockClient() {
  const queryResults: string[] = [];
  // First call returns patterns, subsequent calls return samples
  queryResults.push(JSON.stringify(fixture.patternQueryResult));
  // One sample query per pattern
  for (const _ of fixture.patternQueryResult) {
    queryResults.push(JSON.stringify(fixture.rawLogSamples.map(r => {
      try { return { message: JSON.parse(r).message }; } catch { return { message: r }; }
    })));
  }

  let callIndex = 0;
  return {
    initSession: vi.fn(),
    getQueryInstructions: vi.fn().mockResolvedValue("ok"),
    query: vi.fn().mockImplementation(() => {
      const result = queryResults[callIndex] || "[]";
      callIndex++;
      return Promise.resolve(result);
    }),
  };
}

const testServices: ServiceConfig[] = [
  {
    name: "backend",
    betterstackSources: {
      production: { sourceId: 12345, table: "test_table.logs" },
    },
    jiraProjectKey: "RD",
    githubRepo: "acme-org/acme-backend",
    repoLocalPath: "/tmp/test-repos/acme-backend",
  },
  {
    name: "frontend",
    betterstackSources: {},
    jiraProjectKey: "SS",
    githubRepo: "acme-org/acme-frontend",
    repoLocalPath: "/tmp/test-repos/acme-frontend",
  },
];

describe("scanner", () => {
  it("initializes MCP session", async () => {
    const client = createMockClient();
    await scan(client as any, testServices);
    expect(client.initSession).toHaveBeenCalledOnce();
  });

  it("queries each configured source", async () => {
    const client = createMockClient();
    await scan(client as any, testServices);
    expect(client.getQueryInstructions).toHaveBeenCalledWith(12345);
    // acme-frontend has no sources, should not be queried
    expect(client.getQueryInstructions).toHaveBeenCalledTimes(1);
  });

  it("returns ScannedError[] with correct githubRepo", async () => {
    const client = createMockClient();
    const results = await scan(client as any, testServices);
    expect(results.length).toBe(fixture.patternQueryResult.length);
    expect(results[0].githubRepo).toBe("acme-org/acme-backend");
    expect(results[0].service).toBe("backend");
    expect(results[0].environment).toBe("production");
  });

  it("fetches raw samples per pattern", async () => {
    const client = createMockClient();
    await scan(client as any, testServices);
    // 1 pattern query + 2 sample queries (one per pattern)
    expect(client.query).toHaveBeenCalledTimes(3);
  });
});
