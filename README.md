# Log Monitor Automation

An automated pipeline that scans production logs, classifies errors, creates Jira tickets, generates code fixes using Claude, and monitors CI — all without human intervention.

## How It Works

```
Production Logs (BetterStack)
  → Scan: Query logs via MCP for new errors
  → Classify: Rules-first + AI classification (Critical/High/Medium/Low)
  → Deduplicate: Local state + Jira search to avoid duplicate tickets
  → Group: Semantic dedup groups errors by root cause (deterministic + AI-assisted)
  → Analyze: Claude Sonnet investigates codebase for root cause
  → Ticket: Create Jira ticket with full analysis
  → Fix: Claude Code CLI generates code fix → branch → PR
  → CI Monitor: Poll GitHub Actions, retry fixes on CI failure (up to 3 attempts)
  → Notify: Post Slack digest with run summary
```

## Features

- **Multi-service support** — Monitor multiple services/repos from one pipeline
- **Smart classification** — Editable rules in `classification-rules.json`, AI fallback for unknown patterns
- **Semantic deduplication** — Two-tier grouping prevents duplicate PRs for the same root cause
- **Automated code fixes** — Claude Code CLI generates fixes, creates branches, opens PRs
- **CI fix retry** — Automatically retries when pipeline-opened PRs fail CI
- **Jira lifecycle** — Creates tickets, transitions to Done on PR merge
- **Slack digests** — Per-run summary with error breakdown and PR links
- **Cost tracking** — Tracks Claude API spend per run
- **Atomic state** — JSON file-based state with write-tmp-rename for crash safety

## Architecture

```
src/
├── index.ts              # Health server + cron scheduler
├── config.ts             # Env loading, service definitions (Zod validation)
├── types.ts              # Shared interfaces
├── pipeline/
│   ├── runner.ts         # Full pipeline orchestration
│   ├── scanner.ts        # BetterStack MCP log queries
│   ├── classifier.ts     # Rules-first + AI classification
│   ├── dedup.ts          # Local state + Jira deduplication
│   ├── grouper.ts        # Semantic root-cause grouping
│   ├── analyzer.ts       # Claude Sonnet codebase analysis
│   ├── ticketer.ts       # Jira ticket creation (ADF format)
│   ├── fixer.ts          # Claude Code CLI fix generation → PR
│   ├── ci-fixer.ts       # CI failure detection + fix retry
│   ├── ci-monitor.ts     # GitHub Actions polling + lifecycle
│   └── notifier.ts       # Slack run digest
├── integrations/
│   ├── betterstack.ts    # BetterStack MCP client
│   ├── claude.ts         # Claude API client
│   ├── github.ts         # GitHub (Octokit) client
│   ├── jira.ts           # Jira REST API client
│   └── slack.ts          # Slack webhook/API client
├── state/
│   ├── manager.ts        # Atomic JSON state persistence
│   └── types.ts          # State schema types
└── utils/
    ├── git.ts            # Safe git wrappers (execFileSync, no shell injection)
    ├── cost.ts           # Claude API cost calculation
    ├── lock.ts           # File-based lock
    ├── logger.ts         # Structured logger
    └── sanitizer.ts      # Secret/credential sanitization
```

## Setup

### Prerequisites

- Node.js >= 20
- Git
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed globally
- BetterStack account with MCP access
- Jira Cloud project
- GitHub repo(s) to monitor
- Slack workspace

### Configuration

1. Copy `.env.example` to `.env` and fill in your credentials
2. Edit `src/config.ts` to define your services (BetterStack sources, GitHub repos, Jira projects)
3. Edit `classification-rules.json` to define error priority rules for your domain

### Running

```bash
# Install dependencies
npm install

# Run once (manual trigger)
npm run pipeline

# Run as cron service (default: every 8 hours)
npm run dev

# Run tests
npm test
```

### Deployment

The pipeline is designed to run as a cron service. Included configs for:

- **Railway** — `railway.toml` + `Dockerfile`
- **Any Docker host** — `Dockerfile` + `entrypoint.sh`

The service exposes a `/health` endpoint for uptime monitoring.

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:rules    # Classification rules only
```

101 tests across 16 files covering classification, deduplication, grouping, CI fixing, notification, state management, and integration scenarios.

## Classification Rules

Edit `classification-rules.json` to customize error priority without code changes:

```json
[
  {
    "pattern": "FATAL|panic|OOM",
    "priority": "Critical",
    "category": "crash"
  },
  {
    "pattern": "timeout|ETIMEDOUT",
    "priority": "High",
    "category": "connection"
  }
]
```

Errors not matching any rule are classified by AI (Claude Haiku).

## License

MIT
