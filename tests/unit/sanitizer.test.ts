import { describe, it, expect } from "vitest";
import { sanitizeLogSamples } from "../../src/utils/sanitizer.js";

describe("sanitizeLogSamples", () => {
  it("strips API key patterns", () => {
    const result = sanitizeLogSamples(["Error with api_key=sk-ant-abc123def456 in request"]);
    expect(result[0]).toContain("[REDACTED]");
    expect(result[0]).not.toContain("sk-ant-abc123def456");
  });

  it("strips email addresses", () => {
    const result = sanitizeLogSamples(["User user@example.com encountered error"]);
    expect(result[0]).toContain("[REDACTED]");
    expect(result[0]).not.toContain("user@example.com");
  });

  it("truncates long samples", () => {
    const longSample = "x".repeat(3000);
    const result = sanitizeLogSamples([longSample]);
    expect(result[0].length).toBeLessThanOrEqual(2000);
  });

  it("handles empty arrays", () => {
    expect(sanitizeLogSamples([])).toEqual([]);
  });
});
