# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Local dev server (wrangler dev --test-scheduled)
pnpm test                 # Run stable unit tests
pnpm run test:integration # Run worker integration tests (Cloudflare runtime)
pnpm run deploy           # Deploy to Cloudflare
pnpm exec tsc --noEmit    # Type check
pnpm cf-typegen           # Regenerate worker-configuration.d.ts from wrangler.jsonc
```

Always use **pnpm** as the package manager.

## Architecture

Cloudflare Worker for content aggregation, AI analysis, and embedding generation. Entry point: `src/index.ts`.

### Data Flow

Sources (RSS cron, Twitter cron, manual `/submit`) → Platform crawler → Save to Supabase → Queue message → Workflow (5 steps: fetch → AI analysis → update DB → generate embedding → save embedding).

### Key Modules

- **`src/index.ts`** — Routes HTTP, cron, and queue events
- **`src/app/http.ts`** — HTTP endpoints (`/submit`, `/health`)
- **`src/app/schedule.ts`** — RSS monitor (every 5min) and Twitter list monitor (every 6h)
- **`src/domain/workflow.ts`** — Queue consumer + `NewsenceMonitorWorkflow` orchestration
- **`src/domain/processors.ts`** — Platform-specific AI processors (Default, Twitter, HackerNews)
- **`src/domain/scrapers.ts`** — Platform scrapers (YouTube, Twitter/Kaito, HackerNews/Algolia, Web/cheerio)
- **`src/infra/*.ts`** — External integrations (Supabase, OpenRouter, Workers AI, web utilities)
- **`src/models/types.ts`** — Shared types and bindings

### Worker Bindings

- `ARTICLE_QUEUE` — Cloudflare Queue for async article processing
- `MONITOR_WORKFLOW` — Cloudflare Workflow for the AI pipeline
- `AI` — Workers AI (BGE-M3 embeddings, 1024 dimensions)

### External Services

- **Supabase** — PostgreSQL database (`articles` table with pgvector)
- **OpenRouter** — LLM API (Gemini 2.5 Flash for analysis/translation)
- **Kaito API** (`api.twitterapi.io`) — Twitter data. Tweet media lives in `extendedEntities.media[].media_url_https`
- **YouTube Data API** — Video metadata and transcripts

### Twitter Scraping

Two distinct code paths handle tweets:

1. **`src/domain/scrapers.ts` `scrapeTweet()`** — Called for single tweet/article crawling (manual `/submit`). Uses Kaito `/twitter/tweets` endpoint. Reads `extendedEntities.media` for images.
2. **`src/app/schedule.ts` `saveTweet()`** — Called from Twitter cron. Uses Kaito `/twitter/list/tweets` endpoint. Uses `extractTweetMedia()` helper to read `extendedEntities.media`. The `Tweet` type's `media` field is always null from the API — only `extendedEntities.media` contains image data.

### Processor Pattern

`src/domain/processors.ts` uses a registry pattern. Each processor implements `ArticleProcessor` with a `process()` method. The `getProcessor(sourceType)` function returns the appropriate one. Processors return `{ updateData }` which gets merged into the article row.

## Conventions

- Environment variables are defined in `wrangler.jsonc` (production) — use `wrangler.jsonc.example` as template
- `/submit` supports optional internal-token auth via `CORE_WORKER_INTERNAL_TOKEN` (`X-Internal-Token` header)
- `/submit` has best-effort in-worker rate limit (`SUBMIT_RATE_LIMIT_MAX` and `SUBMIT_RATE_LIMIT_WINDOW_SEC`)
- All AI analysis output is bilingual (English + Traditional Chinese)
- Articles table name is configurable via `ARTICLES_TABLE` env var (default: `articles`)
- Queue messages use discriminated union: `{ type: 'article_process' | 'batch_process', ... }`
