// src/config.ts
import { z } from "zod";

const envSchema = z.object({
  BETTERSTACK_API_TOKEN: z.string().min(1),
  JIRA_BASE_URL: z.string().min(1),
  JIRA_EMAIL: z.string().min(1),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_PROJECT_KEY_SERVICE_A: z.string().default("PROJ"),
  JIRA_PROJECT_KEY_SERVICE_B: z.string().default("PROJ2"),
  GITHUB_ACCESS_TOKEN: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_CHANNEL_ID: z.string().min(1),
  SLACK_WEBHOOK_URL: z.string().default(""),
  ANTHROPIC_API_KEY: z.string().default(""),  // Optional: not needed when using CLAUDE_CODE_OAUTH_TOKEN
  PORT: z.string().default("3000"),
  RUN_SCHEDULE: z.string().default("0 6,14,22 * * *"),
  STATE_DIR: z.string().default("./state"),
  REPOS_DIR: z.string().default("./repos"),
  DRY_RUN: z.string().default("false"),
});

export interface ServiceConfig {
  name: string;
  betterstackSources: {
    production?: { sourceId: number; table: string; collection: string };
    staging?: { sourceId: number; table: string; collection: string };
  };
  jiraProjectKey: string;
  githubRepo: string;
  repoLocalPath: string;
}

export interface PipelineConfig {
  runSchedule: string;
  runTimeoutMinutes: number;
  maxErrorsPerRun: number;
  ciMaxFixAttempts: number;
  maxFileEditsPerFix: number;
  costAlertThresholdUsd: number;
  analysisBranch: string;
  targetBranch: string;
  staleNeedsHumanDays: number;
  statePruneAgeDays: number;
  runHistoryRetentionDays: number;
  ciRetryBudgetMinutes: number;
  ciPollIntervalMs: number;
  ciPollTimeoutMs: number;
}

export interface AppConfig {
  betterstack: { apiToken: string };
  jira: { baseUrl: string; email: string; apiToken: string };
  github: { accessToken: string };
  slack: { botToken: string; channelId: string; webhookUrl: string };
  anthropic: { apiKey: string };
  port: number;
  dryRun: boolean;
  stateDir: string;
  reposDir: string;
  pipeline: PipelineConfig;
  services: ServiceConfig[];
}

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);

  const services: ServiceConfig[] = [
    {
      name: "backend",
      betterstackSources: {
        // Configure your BetterStack source IDs and ClickHouse table names
        production: { sourceId: 0, table: "your_table.production_logs", collection: "your_collection_s3" },
        staging: { sourceId: 0, table: "your_table.staging_logs", collection: "your_collection_staging_s3" },
      },
      jiraProjectKey: env.JIRA_PROJECT_KEY_SERVICE_A,
      githubRepo: "acme-org/acme-backend",
      repoLocalPath: `${env.REPOS_DIR}/acme-backend`,
    },
    {
      name: "frontend",
      betterstackSources: {},
      jiraProjectKey: env.JIRA_PROJECT_KEY_SERVICE_B,
      githubRepo: "acme-org/acme-frontend",
      repoLocalPath: `${env.REPOS_DIR}/acme-frontend`,
    },
  ];

  return {
    betterstack: { apiToken: env.BETTERSTACK_API_TOKEN },
    jira: {
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
    },
    github: { accessToken: env.GITHUB_ACCESS_TOKEN },
    slack: {
      botToken: env.SLACK_BOT_TOKEN,
      channelId: env.SLACK_CHANNEL_ID,
      webhookUrl: env.SLACK_WEBHOOK_URL,
    },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY },
    port: parseInt(env.PORT, 10),
    dryRun: env.DRY_RUN === "true",
    stateDir: env.STATE_DIR,
    reposDir: env.REPOS_DIR,
    pipeline: {
      runSchedule: env.RUN_SCHEDULE,
      runTimeoutMinutes: 60,
      maxErrorsPerRun: 10,
      ciMaxFixAttempts: 3,
      maxFileEditsPerFix: 5,
      costAlertThresholdUsd: 20,
      analysisBranch: "main",
      targetBranch: "development",
      staleNeedsHumanDays: 3,
      statePruneAgeDays: 30,
      runHistoryRetentionDays: 90,
      ciRetryBudgetMinutes: 20,
      ciPollIntervalMs: 30_000,
      ciPollTimeoutMs: 600_000,
    },
    services,
  };
}
