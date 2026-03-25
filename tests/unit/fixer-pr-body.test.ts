import { describe, it, expect } from "vitest";
import { extractFixSummary } from "../../src/pipeline/fixer.js";

describe("extractFixSummary", () => {
  it("extracts a summary section if present", () => {
    const input = `I've made the following changes:

## Summary
Fixed the null check in fill_pipeline.rs by adding proper validation.

## Details
Some other content here.`;
    const result = extractFixSummary(input);
    expect(result).toContain("Fixed the null check");
  });

  it("returns first 500 chars for unstructured responses", () => {
    const input = "I fixed the bug by changing the comparison operator from == to === in the handler function. This ensures type-safe comparison.";
    const result = extractFixSummary(input);
    expect(result).toBe(input);
  });

  it("strips long code blocks", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `  line ${i}`).join("\n");
    const input = `Fixed the issue:\n\`\`\`rust\n${lines}\n\`\`\`\nDone.`;
    const result = extractFixSummary(input);
    expect(result).toContain("[code block omitted");
    expect(result).not.toContain("line 14");
  });

  it("keeps short code blocks", () => {
    const input = "Fixed:\n```rust\nlet x = 1;\nlet y = 2;\n```\nDone.";
    const result = extractFixSummary(input);
    expect(result).toContain("let x = 1;");
  });

  it("truncates to 2000 chars max", () => {
    const input = "A".repeat(2500);
    const result = extractFixSummary(input);
    expect(result.length).toBeLessThanOrEqual(2003); // 2000 + "..."
  });

  it("handles empty Claude response gracefully", () => {
    const result = extractFixSummary("");
    expect(result).toBe("");
  });
});
