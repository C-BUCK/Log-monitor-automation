import { describe, it, expect } from "vitest";
import { classify, classifyAll, loadRules } from "../../src/pipeline/classifier.js";
import type { ScannedError, ClassificationRule } from "../../src/types.js";
import testRules from "../fixtures/classification-rules-test.json";

const rules = testRules as ClassificationRule[];

function makeError(overrides: Partial<ScannedError> = {}): ScannedError {
  return {
    pattern: "some-pattern",
    service: "backend",
    environment: "production",
    githubRepo: "acme-org/acme-backend",
    occurrenceCount: 10,
    exampleMessage: "some error happened",
    level: "error",
    component: null,
    firstSeen: "2026-03-20T06:00:00Z",
    lastSeen: "2026-03-20T13:00:00Z",
    rawSamples: ["sample1"],
    ...overrides,
  };
}

describe("classify", () => {
  it("matches rule: 'quantity mismatch' → Critical, source 'rule'", () => {
    const error = makeError({ exampleMessage: "Trade quantity mismatch detected" });
    const result = classify(error, rules);
    expect(result.priority).toBe("Critical");
    expect(result.prioritySource).toBe("rule");
  });

  it("matches rule: 'punycode' → Skip, source 'rule'", () => {
    const error = makeError({ exampleMessage: "The punycode module is deprecated" });
    const result = classify(error, rules);
    expect(result.priority).toBe("Skip");
    expect(result.prioritySource).toBe("rule");
  });

  it("no rule match, 150 occurrences → High, source 'frequency'", () => {
    const error = makeError({ exampleMessage: "Unknown weird error", occurrenceCount: 150 });
    const result = classify(error, rules);
    expect(result.priority).toBe("High");
    expect(result.prioritySource).toBe("frequency");
  });

  it("no rule match, 3 occurrences → Low, source 'frequency'", () => {
    const error = makeError({ exampleMessage: "Unknown weird error", occurrenceCount: 3 });
    const result = classify(error, rules);
    expect(result.priority).toBe("Low");
    expect(result.prioritySource).toBe("frequency");
  });

  it("no rule match, 50 occurrences → Medium, source 'frequency'", () => {
    const error = makeError({ exampleMessage: "Unknown weird error", occurrenceCount: 50 });
    const result = classify(error, rules);
    expect(result.priority).toBe("Medium");
    expect(result.prioritySource).toBe("frequency");
  });
});

describe("classifyAll", () => {
  it("filters out Skip entries from results", () => {
    const errors = [
      makeError({ exampleMessage: "quantity mismatch" }),
      makeError({ exampleMessage: "punycode deprecated" }),
      makeError({ exampleMessage: "Unknown error", occurrenceCount: 50 }),
    ];
    const result = classifyAll(errors, rules);
    expect(result.length).toBe(2);
    expect(result.find((e) => e.priority === "Skip")).toBeUndefined();
  });
});

describe("loadRules", () => {
  it("loads rules from JSON file", () => {
    // Test with the test fixture path
    const loaded = loadRules("tests/fixtures/classification-rules-test.json");
    expect(loaded.length).toBe(3);
    expect(loaded[0].priority).toBe("Critical");
  });
});
