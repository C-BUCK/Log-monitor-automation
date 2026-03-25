import { describe, it, expect } from "vitest";
import { estimateCost, type TokenUsage } from "../../src/utils/cost.js";

describe("estimateCost", () => {
  it("estimates Haiku cost correctly", () => {
    const usage: TokenUsage = { model: "haiku", inputTokens: 1000, outputTokens: 500 };
    const cost = estimateCost(usage);
    // 1000/1M * $0.80 + 500/1M * $4.00 = $0.0008 + $0.002 = $0.0028
    expect(cost).toBeCloseTo(0.0028, 4);
  });

  it("estimates Sonnet cost correctly", () => {
    const usage: TokenUsage = { model: "sonnet", inputTokens: 10000, outputTokens: 2000 };
    const cost = estimateCost(usage);
    // 10000/1M * $3.00 + 2000/1M * $15.00 = $0.03 + $0.03 = $0.06
    expect(cost).toBeCloseTo(0.06, 4);
  });

  it("estimates Opus cost correctly", () => {
    const usage: TokenUsage = { model: "opus", inputTokens: 50000, outputTokens: 5000 };
    const cost = estimateCost(usage);
    // 50000/1M * $15.00 + 5000/1M * $75.00 = $0.75 + $0.375 = $1.125
    expect(cost).toBeCloseTo(1.125, 4);
  });
});
