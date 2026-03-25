// src/utils/cost.ts
import type { ClaudeModel } from "../types.js";

export interface TokenUsage {
  model: ClaudeModel;
  inputTokens: number;
  outputTokens: number;
}

const PRICING: Record<ClaudeModel, { input: number; output: number }> = {
  haiku: { input: 0.80, output: 4.00 },
  sonnet: { input: 3.00, output: 15.00 },
  opus: { input: 15.00, output: 75.00 },
};

export function estimateCost(usage: TokenUsage): number {
  const price = PRICING[usage.model];
  return (usage.inputTokens / 1_000_000) * price.input +
    (usage.outputTokens / 1_000_000) * price.output;
}
