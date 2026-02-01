# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Local dev server (wrangler dev --test-scheduled)
pnpm test                 # Run tests (vitest)
pnpm run deploy           # Deploy to Cloudflare
pnpm exec tsc --noEmit    # Type check (1 pre-existing error in handlers.ts is expected)
pnpm cf-typegen           # Regenerate worker-configuration.d.ts from wrangler.jsonc
```

Always use **pnpm** as the package manager.

## Architecture

Cloudflare Worker for content aggregation, AI analysis, and embedding generation. Entry point: `src/index.ts`.

### Data Flow

Sources (RSS cron, Twitter cron, manual `/scrape` or `/submit`) → Platform Scraper → Save to Supabase → Queue message → Workflow (5 steps: fetch → AI analysis → update DB → generate embedding → save embedding).

### Key Modules

- **`index.ts`** — Routes HTTP, cron, and queue events
- **`cron.ts`** — RSS monitor (every 5min) and Twitter list monitor (every 6h). Twitter tweets come from Kaito API's list endpoint; media is in `extendedEntities.media` (not the top-level `media` field which is always null)
- **`handlers.ts`** — HTTP endpoints (`/scrape`, `/submit`, `/trigger`, `/health`, etc.)
- **`queue.ts`** — Queue consumer that creates Workflow instances
- **`workflow.ts`** — `NewsenceMonitorWorkflow` class with 5 retry-able steps
- **`processors.ts`** — Platform-specific AI processors (Default, Twitter, HackerNews). Each calls Gemini via OpenRouter for analysis/translation
- **`scrapers.ts`** — Platform scrapers (YouTube, Twitter/Kaito, HackerNews/Algolia, Web/cheerio). `scrapeTweet()` handles 3 paths: Twitter Article, tweet with external link, regular tweet

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

1. **`scrapers.ts` `scrapeTweet()`** — Called for single tweet scraping (manual `/scrape`). Uses Kaito `/twitter/tweets` endpoint. Reads `extendedEntities.media` for images.
2. **`cron.ts` `saveTweet()`** — Called from Twitter cron. Uses Kaito `/twitter/list/tweets` endpoint. Uses `extractTweetMedia()` helper to read `extendedEntities.media`. The `Tweet` type's `media` field is always null from the API — only `extendedEntities.media` contains image data.

### Processor Pattern

`processors.ts` uses a registry pattern. Each processor implements `ArticleProcessor` with a `process()` method. The `getProcessor(sourceType)` function returns the appropriate one. Processors return `{ updateData }` which gets merged into the article row.

## Conventions

- Environment variables are defined in `wrangler.jsonc` (production) — use `wrangler.jsonc.example` as template
- All AI analysis output is bilingual (English + Traditional Chinese)
- Articles table name is configurable via `ARTICLES_TABLE` env var (default: `articles`)
- Queue messages use discriminated union: `{ type: 'article_process' | 'batch_process', ... }`
