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

newsence is a content discovery system. It continuously monitors sources across the web, extracts structured knowledge from every article, and makes it available for search, analysis, and AI-powered workflows.

Think of it as an always-on research assistant that reads everything, extracts who's involved, what technologies are mentioned, and what events are happening — then organizes it all into a searchable knowledge base.

**Core loop:**
```
Sources arrive (RSS, Twitter, YouTube, HN, Bilibili, Xiaohongshu, manual)
  → AI reads and analyzes each article
  → Extracts entities (people, orgs, products, tech, events)
  → Generates bilingual summaries (EN + Traditional Chinese)
  → Creates semantic embeddings for search
  → Links articles through shared entities
```

This repo is the engine: a single Cloudflare Worker that handles the full content pipeline.

## Supported Platforms

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)
![Bilibili](https://img.shields.io/badge/Bilibili-00A1D6?logo=bilibili&logoColor=white)
![Xiaohongshu](https://img.shields.io/badge/Xiaohongshu-FF2442?logo=xiaohongshu&logoColor=white)

| Platform | Type | Schedule | What it does |
|----------|------|----------|--------------|
| **RSS Feeds** | Monitor | Every 5 min | Fetches feeds, deduplicates by URL, detects HN links |
| **Twitter/X** | Monitor | Every 6 hours | Tracks users via Kaito API — tweets, threads, articles, media |
| **YouTube** | Monitor | Every 30 min | Atom feed → video metadata, transcripts, chapters, AI highlights |
| **Bilibili** | Monitor | Every 30 min | gRPC mobile API → user dynamics, video cards |
| **Xiaohongshu** | Monitor | Every 30 min | Profile scraping → user notes, covers |
| **Hacker News** | Processor | Via RSS | Detects HN links → fetches comments via Algolia → generates editorial notes |
| **Web** | Scraper | On demand | Full content extraction (Readability + Cheerio), OG metadata |
| **User Submissions** | Ingestion | Real-time | `POST /submit` — full crawl + AI, sync response |
| **Telegram Bot** | Ingestion | Real-time | Send URL in chat → get bilingual summary back |

All platforms output a unified `ScrapedContent` shape → same AI pipeline.

## How it works

Each article goes through an automated workflow with independent retries:

```
URL arrives (RSS cron / Twitter cron / user submit / Telegram bot)
  │
  ├─  1. Fetch Article ──── Load article from database
  ├─  2. AI Analysis ────── Gemini Flash → bilingual title, summary, tags, keywords, entities
  ├─  3. Fetch OG Image ─── Grab OG image if missing (lightweight, first 32KB)
  ├─  4. Translate Content ─ Full article → Traditional Chinese
  ├─  5. Save to DB ──────── Write all AI results in a single UPDATE
  ├─  5b. Sync Entities ─── Upsert entities to normalized tables, link to article
  ├─  6. Notify Telegram ─── Push results to Telegram bot (if triggered via bot)
  ├─  7. YouTube Highlights  Generate AI highlights from transcript (YouTube only)
  └─  8. Embed ───────────── BGE-M3 → 1024-dim vector from title + summary + content + entities
```

~30 seconds per article. Each step retries independently with exponential backoff.

## AI Pipeline

| Stage | Model | What it does |
|-------|-------|--------------|
| **Analysis** | Gemini Flash Lite | Article → bilingual title, summary, tags, keywords, category |
| **Entity Extraction** | Gemini Flash Lite | Article → named entities (person, organization, product, technology, event) with EN + zh-TW names |
| **Content Translation** | Gemini Flash | Full article content → Traditional Chinese |
| **Embedding** | BGE-M3 (1024d) | Title + summary + content + entity names → dense vector (HNSW-indexed) |

Entity extraction happens in the same LLM call as analysis — zero extra API cost.

## Stack

| Layer | Technology |
|-------|------------|
| Runtime | Cloudflare Workers (V8 isolates) |
| Orchestration | Cloudflare Queues + Workflows |
| Database | Supabase PostgreSQL + pgvector |
| LLM | OpenRouter → Gemini Flash / Flash Lite |
| Embeddings | Cloudflare Workers AI → BGE-M3 |
| Twitter Data | Kaito API |

## Quick Start

```bash
pnpm install
cp wrangler.jsonc.example wrangler.jsonc   # add your API keys
pnpm dev                                    # local dev server
pnpm run deploy                             # deploy to Cloudflare
```

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
  "results": [{
    "articleId": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Article Title",
    "sourceType": "web",
    "alreadyExists": false
  }]
}
```

</details>

Optional auth: `X-Internal-Token` header. Rate limiting: 20 req/60s per key (configurable).

## CLI & MCP

Also available as a CLI and [MCP](https://modelcontextprotocol.io) server:

```bash
npx newsence search "AI agents"       # search articles
npx newsence recent --hours 6         # recent articles

claude mcp add newsence -- npx newsence mcp   # Claude Code
# Remote MCP: https://www.newsence.app/api/mcp
```

## Architecture

```
src/
├── index.ts                  # Entry — routes HTTP, Cron, Queue
├── platforms/                # Each platform is self-contained
│   ├── twitter/              # monitor, scraper, processor, metadata
│   ├── youtube/              # monitor, scraper, highlights, metadata
│   ├── hackernews/           # scraper, processor, metadata
│   ├── rss/                  # monitor, parser, feed-config
│   └── web/                  # scraper (shared web + OG extraction)
├── domain/
│   ├── workflow.ts           # Workflow orchestration
│   ├── processors.ts         # AI processor factory + DefaultProcessor
│   ├── ai-utils.ts           # Shared AI functions (Gemini, translation)
│   ├── entities.ts           # Entity sync to normalized tables
│   └── distribute.ts         # Subscription fan-out for non-default sources
├── infra/                    # OpenRouter, Workers AI, DB, HTTP utilities
├── models/                   # Types, platform metadata union
└── app/handlers/             # HTTP route handlers
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `CORE_WORKER_INTERNAL_TOKEN` | No | Auth token for `/submit` |
| `YOUTUBE_API_KEY` | No | YouTube Data API |
| `KAITO_API_KEY` | No | Kaito API (Twitter) |
| `TRANSCRIPT_API_KEY` | No | YouTube transcript API |

## License

MIT
