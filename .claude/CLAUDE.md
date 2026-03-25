# Log Monitor Automation - Claude Guide

## Project Overview

Automated log-to-fix pipeline that runs as a cron service. Scans production logs (BetterStack), classifies errors, creates Jira tickets, generates code fixes via Claude Code CLI, monitors CI, and posts Slack digests.

## Tech Stack

- **Runtime:** Node.js 20+ / TypeScript (ESM)
- **Testing:** Vitest (`npm test`)
- **Deployment:** Railway (cron) or any Docker host
- **Integrations:** BetterStack MCP, Jira Cloud, GitHub (Octokit), Slack, Claude API

## Code Structure

- `src/pipeline/runner.ts` — Main orchestrator (scan → classify → dedup → analyze → ticket → fix → CI monitor → notify)
- `src/config.ts` — Service definitions, env loading (Zod validation)
- `src/integrations/` — External service clients
- `src/state/` — Atomic JSON state persistence
- `src/utils/` — Git wrappers, sanitizer, cost tracking
- `classification-rules.json` — Editable error priority rules (no code change needed)

## Testing

- **Framework:** Vitest with explicit imports (describe/it/expect from "vitest")
- **Unit tests:** `tests/unit/`
- **Integration tests:** `tests/integration/`
- **Run:** `npm test` or `npx vitest run`
- **101 tests** across 16 test files

## Conventions

- All env vars validated with Zod schemas
- Git operations use `execFileSync` (no shell injection)
- State persistence uses write-tmp-rename for crash safety
- Log samples are sanitized before Jira/PR/Slack output
- File-based lock prevents concurrent pipeline runs

## Key Rules

- Never commit secrets or credentials
- Always sanitize log output before external APIs
- Use `execFileSync` for git, never `execSync` with string commands
- Stage individual files in git (not `git add -A`)
