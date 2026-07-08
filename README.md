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

Ingestion engine for [**newsence.app**](https://www.newsence.app). Pulls contents from RSS / Twitter/X / YouTube / Hacker News / web URLs / user files, runs bilingual AI analysis on each, stores them as searchable embeddings and an entity graph. Follows the [**LLM Wiki**](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern — each source is read once and integrated into a persistent artifact (summaries, entities, embeddings, cross-refs), not RAG'd at query time.

## Supported Platforms

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)

| Platform             | Type      | Schedule      | What it does                                                                |
| -------------------- | --------- | ------------- | --------------------------------------------------------------------------- |
| **RSS Feeds**        | Monitor   | Every 5 min   | Fetches feeds, deduplicates by URL, detects HN links                        |
| **Twitter/X**        | Monitor   | Every 6 hours | Tracks users via Kaito API — tweets, threads, articles, media               |
| **YouTube**          | Monitor   | Every 30 min  | Atom feed → video metadata, transcripts, chapters, AI highlights            |
| **Hacker News**      | Processor | Via RSS       | Detects HN links → fetches comments via Algolia → generates editorial notes |
| **Web**              | Scraper   | Saved URL     | Full content extraction (Readability + Cheerio), OG metadata                |
| **User Files**       | Ingestion | Real-time     | App service-binding RPC — saved URL scrape + enrichment; blob lifecycle stays app-owned |

All platforms output a unified `ExtractedContent` shape → same AI pipeline.

## How it works

Each article goes through an automated workflow with independent retries:

```
Content arrives (source monitor / saved URL / retry)
  │
  ├─ 1. Load Content ───────── Source draft from R2, or user_file/article row for upload/retry
  ├─ 2. AI Analysis ────────── AI Gateway text/JSON calls → bilingual title, summary, tags, keywords, entities
  ├─ 3. Save to DB ─────────── Source: single final INSERT; row-based: one final UPDATE
  ├─    Sync Entities ──────── (conditional) Upsert entities, link to article
  ├─ 4. YouTube Highlights ─── (YouTube only) Transcript → AI highlight segments
  └─ 5. Embed ─────────────── BGE-M3 → 1024-dim vector from title + summary + content + entities
```

Roughly 30 seconds per article. Each step retries independently with exponential backoff.

## AI Pipeline

| Stage                   | Model             | What it does                                                                                      |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| **Analysis**          | AI Gateway text model | Article → bilingual title, summary, tags, keywords, category                                      |
| **Entity Extraction** | AI Gateway JSON model | Article → named entities (person, organization, product, technology, event, location) with EN + zh-TW names |
| **Embedding**         | BGE-M3 (1024d)        | Title + summary + content + entity names → dense vector (HNSW-indexed)                            |

Translation/summary and classification/entities are separate structured calls so one schema failure does not force the whole article into fallback.

### Entity Quality Policy

The core worker keeps entity storage deterministic and conservative. It normalizes obvious duplicates, gates known entity types, filters generic tokens and self-source aliases, and caps stored entities per article.

It intentionally does not perform semantic alias merging in the database. Model families, company/product containment, and OKF-style alias groups are presentation or export-layer concerns until they have a reviewed alias source. For example, `google`, `google deepmind`, and `gemini` can be related without being the same canonical database entity.

Change the DB schema only when the product needs a query shape that the current `entities` plus `article_entities` graph cannot represent cleanly. The two likely future additions are an `entity_aliases` table for reviewed aliases and an `entity_extraction_runs` table for audit/debug history; neither should be used to paper over prompt or source-quality bugs.

## Stack

| Layer         | Technology                                        |
| ------------- | ------------------------------------------------- |
| Runtime       | Cloudflare Workers (V8 isolates)                  |
| Orchestration | Cloudflare Workflows                              |
| Database      | PostgreSQL + pgvector (via Cloudflare Hyperdrive) |
| LLM           | Cloudflare AI Gateway                             |
| Embeddings    | Cloudflare Workers AI → BGE-M3                    |
| Twitter Data  | Kaito API (third-party)                           |

## Self-Hosting

The one-click Deploy button above handles Worker + Workflows, but **Hyperdrive, the database, and secrets need manual setup**. Full walkthrough:

### 1. Database

You need a PostgreSQL instance with pgvector. Currently runs on PlanetScale Postgres (via Cloudflare Hyperdrive); any Postgres ≥ 15 with the `vector` extension works.

Required tables: `articles`, `user_articles`, `RssList`, `youtube_transcripts`, plus entity/citation tables. The canonical schema is defined in `web-tanstack/prisma/schema.prisma` in the parent monorepo — a standalone `schema.sql` is on the roadmap. For now, inspect the Prisma models or reach out via Issues if you want to run just the worker.

### 2. Hyperdrive binding

Create a Hyperdrive that points to your database:

```bash
wrangler hyperdrive create newsence-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

Copy the returned ID into `wrangler.jsonc` under the `hyperdrive[].id` field.

### 3. Cloudflare Workflows

Workflows are provisioned automatically on first deploy via the `workflows` bindings in `wrangler.jsonc`.

### 4. Secrets

AI analysis and embeddings use the Workers AI binding, so no external LLM secret is required. Platform/API secrets are required by Wrangler config:

```bash
wrangler secret put CORE_WORKER_INTERNAL_TOKEN  # auth for protected HTTP endpoints
wrangler secret put KAITO_API_KEY            # Twitter monitoring
wrangler secret put YOUTUBE_API_KEY          # YouTube monitoring
wrangler secret put S2_API_KEY               # Semantic Scholar quota
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

# Ingest URLs
curl -X POST https://your-worker.workers.dev/ingest \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $CORE_WORKER_INTERNAL_TOKEN" \
  -d '{"urls": ["https://example.com/article"], "userId": "user-id"}'

```

<details>
<summary>Response example</summary>

```json
{
  "success": true,
  "data": [
    {
      "url": "https://example.com/article",
      "userFileId": "550e8400-e29b-41d4-a716-446655440000",
      "instanceId": "workflow-id",
      "resourceKind": "url"
    }
  ]
}
```

</details>

Auth: internal endpoints require `X-Internal-Token` or `Authorization: Bearer`. User ingest rate limiting now lives in the app Worker before calls reach this core Worker.

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
├── entrypoints/          # HTTP router, protected endpoints, health
├── rpc/                  # service-binding RPC contract
├── ai/                   # Workers AI / AI Gateway helpers
├── entities/             # entity normalization + graph sync
├── media/                # OG image helpers
├── shared/               # small cross-subsystem primitives
│   ├── mime.ts           # MIME sniffing and upload limits
│   ├── platform-metadata.ts
│   ├── types.ts          # Article, ExtractedContent, YoutubeTranscript
│   └── web.ts            # fetch, URL normalization, stream limits
├── ingest/               # ── article ingestion pipeline (the open-source core) ──
│   ├── extract.ts        # URL detection dispatch → platform scraper
│   ├── workflow.ts       # Workflow class + enqueueProcessing
│   ├── urls.ts           # saved URL orchestration; app persists blob results
│   ├── domain/           # sink and AI merge helpers
│   ├── platforms/        # each platform lives in its own folder
│   │   ├── rss/          # feed polling
│   │   ├── twitter/      # monitor + scraper + processor
│   │   ├── youtube/      # monitor + scraper + transcript/highlights
│   │   ├── hackernews/   # scraper + processor (fed by RSS or URL)
│   │   ├── paper/        # Semantic Scholar enrichment
│   │   ├── pdf.ts        # PDF text extraction stage
│   │   └── web-scraper.ts
└── corpus.ts · okf.ts     # engine read/search/export helpers
```

## Environment Variables & Bindings

Bindings (in `wrangler.jsonc`):

| Binding            | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `HYPERDRIVE`       | Hyperdrive connection to your Postgres       |
| `MONITOR_WORKFLOW` | `NewsenceMonitorWorkflow` instance creator   |
| `R2`               | Source drafts, PDF text temp objects, and app-owned blob reads |
| `AI`               | Workers AI binding (AI Gateway text calls + BGE-M3 embeddings) |

Secrets (via `wrangler secret put`):

| Variable                       | Required | Description                              |
| ------------------------------ | -------- | ---------------------------------------- |
| `CORE_WORKER_INTERNAL_TOKEN`   | Yes      | Token for protected HTTP endpoints; service-binding RPC callers do not use it |
| `KAITO_API_KEY`                | Yes      | Enables Twitter monitoring               |
| `YOUTUBE_API_KEY`              | Yes      | Enables YouTube channel monitoring       |
| `S2_API_KEY`                   | Yes      | Increases Semantic Scholar quota for paper enrichment |

## Adding a Platform

Platforms are source adapters. Each platform folder contains some combination of `monitor.ts` (cron discovery), `scraper.ts` (URL-triggered fetch), metadata builders, and optionally `processor.ts` (custom AI analysis). Not every platform has all four; pick the closest existing one and copy its shape.

Keep the axes separate: platform (`rss`, `web`, `youtube`, `twitter`, `hackernews`) is not content shape (`pdf`, academic paper) and not origin (`upload`, `saved_url`, `generated`). PDF extraction and Semantic Scholar paper enrichment are workflow stages keyed from row content/metadata, not platform adapters.

Minimum to add a new source:

1. **Scraper** (`ingest/platforms/foo/scraper.ts`) — export a function that returns `ExtractedContent`.
2. **Metadata** (`ingest/platforms/foo/metadata.ts`) — define your `FooMetadata` shape and a `buildFoo(...)` constructor; register it in `shared/platform-metadata.ts`.
3. **Detection + dispatch** — add the URL pattern to `shared/web.ts:detectUrlKind` and route it from `ingest/extract.ts`.
4. **Monitor** (optional, `ingest/platforms/foo/monitor.ts`) — if the source is pollable, mirror one of the existing cron handlers; wire it into `src/index.ts`.
5. **Processor** (optional, `ingest/platforms/foo/processor.ts`) — only if you need AI behavior that differs from the default workflow processor; register it from `ingest/workflow.ts`.

The new article goes through the same Workflow pipeline as every other platform — you don't touch the AI steps.

## License

MIT
