// src/integrations/claude.ts
import { execFileSync } from "node:child_process";
import { logger } from "../utils/logger.js";
import type { ClaudeModel } from "../types.js";

const MODEL_FLAGS: Record<ClaudeModel, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

export class ClaudeApiDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeApiDownError";
  }
}

export class ClaudeClient {
  private dryRun: boolean;
  private completeFailures = 0;
  private codeEditFailures = 0;
  private callCount = 0;

  constructor(_apiKey: string, dryRun = false) {
    this.dryRun = dryRun;
  }

  /**
   * Simple text-in/text-out prompt via `claude -p`.
   * Used by classifier and analyzer.
   */
  async complete(
    model: ClaudeModel,
    systemPrompt: string,
    userPrompt: string,
    maxTokens = 4096
  ): Promise<{ text: string }> {
    if (this.completeFailures >= 3) {
      throw new ClaudeApiDownError(
        `Claude CLI appears down (${this.completeFailures} consecutive complete() failures)`
      );
    }

    if (this.dryRun) {
      return { text: "[DRY RUN] No CLI call made" };
    }

    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n${userPrompt}`
      : userPrompt;

    try {
      const startMs = Date.now();
      const args = [
        "-p", fullPrompt,
        "--model", MODEL_FLAGS[model],
        "--output-format", "text",
        "--dangerously-skip-permissions",
      ];
      if (maxTokens) {
        args.push("--max-tokens", String(maxTokens));
      }
      const result = execFileSync("claude", args, {
        encoding: "utf-8",
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      }).trim();

      this.completeFailures = 0;
      this.callCount++;
      const durationMs = Date.now() - startMs;
      logger.info("Claude CLI call", { model, durationMs, responseLength: result.length });
      return { text: result };
    } catch (err) {
      this.completeFailures++;
      const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString().substring(0, 500) || "";
      const exitCode = (err as { status?: number })?.status;
      logger.error("Claude CLI call failed", { model, error: String(err).substring(0, 300), stderr, exitCode });
      throw err;
    }
  }

  /**
   * Run Claude Code in a directory with tool access.
   * Used by fixer (Edit, Read, Write, Bash) and analyzer (Read, Grep, Glob).
   */
  async codeEdit(
    prompt: string,
    cwd: string,
    allowedTools: string[],
    model: ClaudeModel = "sonnet"
  ): Promise<{ text: string }> {
    if (this.codeEditFailures >= 3) {
      throw new ClaudeApiDownError(
        `Claude CLI appears down (${this.codeEditFailures} consecutive codeEdit() failures)`
      );
    }

    if (this.dryRun) {
      return { text: "[DRY RUN] No CLI call made" };
    }

    try {
      const startMs = Date.now();
      const args = [
        "-p", prompt,
        "--model", MODEL_FLAGS[model],
        "--output-format", "text",
        "--dangerously-skip-permissions",
        "--allowedTools", allowedTools.join(","),
      ];

      const result = execFileSync("claude", args, {
        cwd,
        encoding: "utf-8",
        timeout: 900_000, // 15 minutes for code edits
        maxBuffer: 10 * 1024 * 1024,
      }).trim();

      this.codeEditFailures = 0;
      this.callCount++;
      const durationMs = Date.now() - startMs;
      logger.info("Claude CLI codeEdit", { model, cwd, durationMs, tools: allowedTools });
      return { text: result };
    } catch (err) {
      this.codeEditFailures++;
      const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString().substring(0, 500) || "";
      const exitCode = (err as { status?: number })?.status;
      logger.error("Claude CLI codeEdit failed", { model, cwd, exitCode, stderr, error: String(err).substring(0, 300) });
      throw err;
    }
  }

  getCallCount(): number {
    return this.callCount;
  }

  // Keep interface compatible — no token-level cost tracking with CLI
  getTotalCost(): number {
    return 0;
  }
}
