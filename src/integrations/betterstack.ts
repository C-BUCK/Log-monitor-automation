// src/integrations/betterstack.ts
import { logger } from "../utils/logger.js";

export class BetterStackClient {
  private apiToken: string;
  private sessionId: string | null = null;
  private dryRun: boolean;
  private requestId = 0;

  constructor(apiToken: string, dryRun = false) {
    this.apiToken = apiToken;
    this.dryRun = dryRun;
  }

  async initSession(): Promise<void> {
    if (this.dryRun) {
      logger.info("[DRY RUN] BetterStack MCP session init skipped");
      return;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("https://mcp.betterstack.com/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${this.apiToken}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: this.nextId(),
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "log-monitor", version: "1.0.0" },
            },
          }),
        });

        const sessionId = res.headers.get("Mcp-Session-Id") || res.headers.get("mcp-session-id");
        const body = await res.text();
        if (!sessionId) {
          logger.error("BetterStack MCP init: no session ID", {
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body: body.substring(0, 500),
          });
          throw new Error("No Mcp-Session-Id in response");
        }
        this.sessionId = sessionId;
        logger.info("BetterStack MCP session initialized", { sessionId });
        return;
      } catch (err) {
        if (attempt === 0) {
          logger.warn("BetterStack MCP init failed, retrying in 1s", { error: String(err) });
          await new Promise((r) => setTimeout(r, 1000));
        } else {
          throw err;
        }
      }
    }
  }

  async getQueryInstructions(sourceId: number): Promise<string> {
    return this.callTool("telemetry_get_query_instructions_tool", { id: sourceId, source_type: "logs" });
  }

  async query(sourceId: number, sql: string, table: string): Promise<string> {
    return this.callTool("telemetry_query", { source_id: sourceId, query: sql, table });
  }

  private async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (this.dryRun) {
      return "[]";
    }

    if (!this.sessionId) {
      throw new Error("BetterStack MCP session not initialized. Call initSession() first.");
    }

    const res = await fetch("https://mcp.betterstack.com/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.apiToken}`,
        "Mcp-Session-Id": this.sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    const data = await this.parseResponse(res);

    if (data.error) {
      throw new Error(`BetterStack MCP error: ${data.error.message}`);
    }

    const text = data.result?.content?.[0]?.text;
    if (!text) {
      logger.warn("BetterStack MCP returned no content — response may be malformed", {
        tool: toolName,
        hasResult: !!data.result,
        contentLength: data.result?.content?.length ?? 0,
      });
      throw new Error(`BetterStack MCP returned empty content for tool ${toolName}`);
    }
    return text;
  }

  /**
   * Parse an MCP response that may be JSON or SSE (text/event-stream).
   * SSE format: "event: message\ndata: {json}\n\n"
   */
  private async parseResponse(res: Response): Promise<{
    result?: { content?: Array<{ type: string; text: string }> };
    error?: { message: string };
  }> {
    const contentType = res.headers.get("content-type") || "";
    const body = await res.text();

    if (contentType.includes("text/event-stream")) {
      // Parse SSE: extract JSON from "data: " lines
      const dataLines = body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
      const jsonStr = dataLines.join("");
      if (!jsonStr) {
        throw new Error(`Empty SSE response from BetterStack MCP`);
      }
      return JSON.parse(jsonStr);
    }

    // Plain JSON response
    return JSON.parse(body);
  }

  private nextId(): number {
    return ++this.requestId;
  }
}
