<div align="center">

# newsence

**A content discovery engine that helps LLMs understand your world**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![npm: newsence](https://img.shields.io/npm/v/newsence?label=npm%3A%20newsence&color=cb3837&logo=npm)](https://www.npmjs.com/package/newsence)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?logo=anthropic&logoColor=white)](https://www.newsence.app/api/mcp)
[![Website](https://img.shields.io/badge/newsence.app-live-00c853)](https://www.newsence.app)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/newsence)

[English](README.md) | [繁體中文](README.zh-TW.md)

</div>

---

## What is newsence?

Ingestion engine for [**newsence.app**](https://www.newsence.app). Pulls contents from RSS / Twitter / YouTube / HN / Bilibili / Xiaohongshu, runs bilingual AI analysis on each, stores them as searchable embeddings, entities graph. Follows the [**LLM Wiki**](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern — each source is read once and integrated into a persistent artifact (summaries, entities, embeddings, cross-refs), not RAG'd at query time.

## Supported Platforms

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)
![Bilibili](https://img.shields.io/badge/Bilibili-00A1D6?logo=bilibili&logoColor=white)
![Xiaohongshu](https://img.shields.io/badge/Xiaohongshu-FF2442?logo=xiaohongshu&logoColor=white)

| Platform             | Type      | Schedule      | What it does                                                                |
| -------------------- | --------- | ------------- | --------------------------------------------------------------------------- |
| **RSS Feeds**        | Monitor   | Every 5 min   | Fetches feeds, deduplicates by URL, detects HN links                        |
| **Twitter/X**        | Monitor   | Every 6 hours | Tracks users via Kaito API — tweets, threads, articles, media               |
| **YouTube**          | Monitor   | Every 30 min  | Atom feed → video metadata, transcripts, chapters, AI highlights            |
| **Bilibili**         | Monitor   | Every 30 min  | gRPC mobile API → user dynamics, video cards                                |
| **Xiaohongshu**      | Monitor   | Every 30 min  | Profile scraping → user notes, covers                                       |
| **Hacker News**      | Processor | Via RSS       | Detects HN links → fetches comments via Algolia → generates editorial notes |
| **Web**              | Scraper   | On demand     | Full content extraction (Readability + Cheerio), OG metadata                |
| **User Submissions** | Ingestion | Real-time     | `POST /submit` — full crawl + workflow, sync response                       |

All platforms output a unified `ScrapedContent` shape → same AI pipeline.

## How it works

Each article goes through an automated workflow with independent retries:

```
URL arrives (RSS cron / Twitter cron / YouTube cron / /submit)
  │
  ├─ 1. Fetch Article ──────── Load article row from database
  ├─ 2. AI Analysis ────────── Gemini Flash Lite → bilingual title, summary, tags, keywords, entities
  ├─ 3. Fetch OG Image ─────── Grab OG image if missing (first 32 KB of HTML)
  ├─ 4. Translate Content ──── Full article → Traditional Chinese
  ├─ 5. Save to DB ─────────── Write all AI results in a single UPDATE
  ├─    Sync Entities ──────── (conditional) Upsert entities, link to article
  ├─ 6. YouTube Highlights ─── (YouTube only) Transcript → AI highlight segments
  └─ 7. Embed ─────────────── BGE-M3 → 1024-dim vector from title + summary + content + entities
```

Roughly 30 seconds per article. Each step retries independently with exponential backoff.

## AI Pipeline

| Stage                   | Model             | What it does                                                                                      |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| **Analysis**            | Gemini Flash Lite | Article → bilingual title, summary, tags, keywords, category                                      |
| **Entity Extraction**   | Gemini Flash Lite | Article → named entities (person, organization, product, technology, event) with EN + zh-TW names |
| **Content Translation** | Gemini Flash      | Full article content → Traditional Chinese                                                        |
| **Embedding**           | BGE-M3 (1024d)    | Title + summary + content + entity names → dense vector (HNSW-indexed)                            |

Entity extraction happens in the same LLM call as analysis — zero extra API cost.

## Stack

| Layer         | Technology                                        |
| ------------- | ------------------------------------------------- |
| Runtime       | Cloudflare Workers (V8 isolates)                  |
| Orchestration | Cloudflare Queues + Workflows                     |
| Database      | PostgreSQL + pgvector (via Cloudflare Hyperdrive) |
| LLM           | OpenRouter → Gemini Flash / Flash Lite            |
| Embeddings    | Cloudflare Workers AI → BGE-M3                    |
| Twitter Data  | Kaito API (third-party)                           |

## Self-Hosting

The one-click Deploy button above handles Worker + Queue + Workflow, but **Hyperdrive, the database, and secrets need manual setup**. Full walkthrough:

### 1. Database

You need a PostgreSQL instance with pgvector. Tested with Supabase; any Postgres ≥ 15 with the `vector` extension works.

Required tables: `articles`, `user_articles`, `RssList`, `youtube_transcripts`, plus entity/citation tables. The canonical schema is defined in `frontend/prisma/schema.prisma` in the parent monorepo — a standalone `schema.sql` is on the roadmap. For now, inspect the Prisma models or reach out via Issues if you want to run just the worker.

### 2. Hyperdrive binding

Create a Hyperdrive that points to your database:

```bash
wrangler hyperdrive create newsence-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

Copy the returned ID into `wrangler.jsonc` under the `hyperdrive[].id` field.

### 3. Cloudflare Queues + Workflow

Create the article-processing queue (the Worker is already configured as both producer and consumer):

```bash
wrangler queues create article-processing-queue-core
wrangler queues create article-processing-dlq-core
```

Workflows are provisioned automatically on first deploy via the `workflows` binding in `wrangler.jsonc`.

### 4. Secrets

Only `OPENROUTER_API_KEY` is strictly required. The others enable specific platforms:

```bash
wrangler secret put OPENROUTER_API_KEY       # required — AI analysis
wrangler secret put KAITO_API_KEY            # optional — Twitter monitoring
wrangler secret put YOUTUBE_API_KEY          # optional — YouTube monitoring
wrangler secret put CORE_WORKER_INTERNAL_TOKEN  # optional — auth for /submit
```

### 5. Deploy

```bash
pnpm install
pnpm run deploy
```

Or run locally with `pnpm dev` (uses `wrangler dev --test-scheduled`, so you can curl `/__scheduled?cron=*/5+*+*+*+*` to trigger RSS manually).

## API

```bash
# Health check
curl https://your-worker.workers.dev/health

# Submit a URL
curl -X POST https://your-worker.workers.dev/submit \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article"}'

# Generate embeddings
curl -X POST https://your-worker.workers.dev/embed \
  -H "Content-Type: application/json" \
  -d '{"text": "search query"}'
```

<details>
<summary>Response example</summary>

```json
{
  "success": true,
  "results": [
    {
      "articleId": "550e8400-e29b-41d4-a716-446655440000",
      "title": "Article Title",
      "sourceType": "web",
      "alreadyExists": false
    }
  ]
}
```

</details>

Optional auth: `X-Internal-Token` header. Rate limiting: 20 req/60s per key (configurable via `SUBMIT_RATE_LIMIT_MAX` / `SUBMIT_RATE_LIMIT_WINDOW_SEC`).

## CLI & MCP

Also available as a CLI and [MCP](https://modelcontextprotocol.io) server via the separate [`newsence`](https://www.npmjs.com/package/newsence) npm package:

```bash
npx newsence search "AI agents"       # search articles
npx newsence recent --hours 6         # recent articles

claude mcp add newsence -- npx newsence mcp   # Claude Code
# Remote MCP: https://www.newsence.app/api/mcp
```

## Architecture

```
src/
├── index.ts              # Cloudflare WorkerEntrypoint class only
├── entrypoints/          # HTTP, scheduled, queue, and RPC adapters
├── app/
│   ├── handlers/         # Thin HTTP route handlers (/submit, /preview, /embed, /health)
│   ├── use-cases/        # Application actions shared by HTTP + RPC
│   ├── monitors/         # Cross-platform scheduled maintenance
│   └── workflows/        # Queue consumer, Workflow class, and workflow steps
├── platforms/            # Each platform lives in its own folder
│   ├── registry.ts       # URL detection dispatch → platform scraper
│   ├── twitter/          # monitor + scraper + processor + metadata
│   ├── youtube/          # monitor + scraper + highlights + metadata
│   ├── hackernews/       # scraper + processor + metadata (no monitor — fed by RSS)
│   ├── bilibili/         # monitor + scraper + metadata
│   ├── xiaohongshu/      # monitor + scraper + metadata
│   ├── rss/              # monitor + parser + feed-config
│   └── web/              # shared scraper (Readability + Cheerio + OG extraction)
├── domain/
│   ├── content/          # Shared content cleanup and editorial domain helpers
│   ├── processing/       # AI processor registry, DefaultProcessor, AI helpers
│   └── entities.ts       # Entity sync to normalized tables
├── infra/
│   ├── db.ts             # Hyperdrive client + insertArticle / dedup / transcript helpers
│   ├── fetch.ts          # fetchWithTimeout
│   ├── log.ts            # Structured JSON logging
│   └── openrouter.ts     # OpenRouter + embedding wrappers
└── models/               # Types + PlatformMetadata discriminated union
```

## Environment Variables & Bindings

Bindings (in `wrangler.jsonc`):

| Binding            | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `HYPERDRIVE`       | Hyperdrive connection to your Postgres       |
| `ARTICLE_QUEUE`    | Producer for `article-processing-queue-core` |
| `MONITOR_WORKFLOW` | `NewsenceMonitorWorkflow` instance creator   |
| `AI`               | Workers AI (BGE-M3 embeddings)               |
| `BROWSER`          | Cloudflare Browser Rendering (reserved)      |

Secrets (via `wrangler secret put`):

| Variable                       | Required | Description                              |
| ------------------------------ | -------- | ---------------------------------------- |
| `OPENROUTER_API_KEY`           | Yes      | OpenRouter (Gemini) for AI analysis      |
| `CORE_WORKER_INTERNAL_TOKEN`   | No       | Bearer token for `/submit` endpoint      |
| `KAITO_API_KEY`                | No       | Enables Twitter monitoring               |
| `YOUTUBE_API_KEY`              | No       | Enables YouTube channel monitoring       |
| `SUBMIT_RATE_LIMIT_MAX`        | No       | Requests allowed per window (default 20) |
| `SUBMIT_RATE_LIMIT_WINDOW_SEC` | No       | Window in seconds (default 60)           |

## Adding a Platform

Platforms today follow a loose convention rather than a formal interface — each platform folder contains some combination of `monitor.ts` (cron ingestion), `scraper.ts` (URL-triggered fetch), `metadata.ts` (typed platform metadata + builders), and optionally `processor.ts` (custom AI analysis). Not every platform has all four; pick the closest existing one and copy its shape.

Minimum to add a new source:

1. **Scraper** (`platforms/foo/scraper.ts`) — export a function that returns `ScrapedContent`.
2. **Metadata** (`platforms/foo/metadata.ts`) — define your `FooMetadata` shape and a `buildFoo(...)` constructor; register it in `models/platform-metadata.ts`.
3. **Detection + dispatch** — add the URL pattern to `models/scraped-content.ts:detectPlatformType` and route it in `platforms/registry.ts`.
4. **Monitor** (optional, `platforms/foo/monitor.ts`) — if the source is pollable, mirror one of the existing cron handlers; wire it into `entrypoints/scheduled.ts`.
5. **Processor** (optional, `platforms/foo/processor.ts`) — only if you need AI behavior that differs from `DefaultProcessor`; register in `domain/processing/processors.ts`.

The new article goes through the same Queue → Workflow pipeline as every other platform — you don't touch the AI steps.

## License

MIT
