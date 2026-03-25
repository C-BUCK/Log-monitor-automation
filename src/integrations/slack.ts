// src/integrations/slack.ts
import { logger } from "../utils/logger.js";

export class SlackClient {
  private botToken: string;
  private channelId: string;
  private webhookUrl: string;
  private dryRun: boolean;

  constructor(botToken: string, channelId: string, webhookUrl: string, dryRun = false) {
    this.botToken = botToken;
    this.channelId = channelId;
    this.webhookUrl = webhookUrl;
    this.dryRun = dryRun;
  }

  async postMessage(text: string): Promise<boolean> {
    if (this.dryRun) {
      logger.info("[DRY RUN] Slack message", { text: text.substring(0, 200) });
      return true;
    }

    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: this.channelId, text }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) return true;

      logger.warn("Slack API error, trying webhook fallback", { error: data.error });
      return this.postViaWebhook(text);
    } catch (err) {
      logger.warn("Slack API failed, trying webhook fallback", { error: String(err) });
      return this.postViaWebhook(text);
    }
  }

  private async postViaWebhook(text: string): Promise<boolean> {
    if (!this.webhookUrl) {
      logger.error("No Slack webhook URL configured for fallback");
      return false;
    }
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return res.ok;
    } catch (err) {
      logger.error("Slack webhook also failed", { error: String(err) });
      return false;
    }
  }
}
