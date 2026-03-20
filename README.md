<div align="center">

# newsence

**Open-source AI-powered news intelligence engine**

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

[newsence.app](https://www.newsence.app) monitors 100+ sources across RSS, Twitter, YouTube, and Hacker News — translating every article into bilingual summaries (EN/繁中), generating semantic embeddings for search, and clustering breaking stories into topics, all in real time.

This repo is the core engine: a single Cloudflare Worker that handles the full content pipeline.

## How it works

Each article goes through a 7-step workflow, fully automated with independent retries:

```
URL arrives (RSS cron / Twitter cron / user submit / Telegram bot)
  │
  ├─ 1. Scrape ─────────── Platform-aware crawler extracts content, metadata, OG image
  ├─ 2. AI Analysis ────── Gemini 2.5 Flash → bilingual title, summary, tags, keywords
  ├─ 3. Save to DB ─────── Write to Supabase PostgreSQL
  ├─ 4. Embed ──────────── BGE-M3 → 1024-dim semantic vector via Workers AI
  ├─ 5. Save Embedding ─── Store vector for pgvector similarity search
  ├─ 6. Topic Clustering ─ Cosine similarity > 0.85 → assign to topic group
  └─ 7. Topic Synthesis ── AI generates topic headline at 2/3/5/10 articles
```

~30 seconds per article. Each step retries x3 with exponential backoff.

## Ingestion Sources

| Source | Schedule | How it works |
|--------|----------|--------------|
| **RSS Feeds** | Every 5 min | Cron fetches feeds, deduplicates by URL |
| **Twitter Lists** | Every 6 hours | Pulls high-engagement tweets via Kaito API |
| **User Submissions** | Real-time | `POST /submit` — full crawl + AI, sync response |
| **Telegram Bot** | Real-time | Send URL in chat → get bilingual summary back |

## Platform Scrapers

| Platform | What it extracts |
|----------|------------------|
| **YouTube** | Video metadata, captions, chapters, thumbnails |
| **Twitter/X** | Tweet text, threads, engagement metrics, media |
| **Hacker News** | Original article + HN discussion via Algolia API |
| **Web** (default) | Full content via Cheerio, OG metadata, author, date |

All scrapers output a unified `ScrapedContent` shape → same AI pipeline.

## AI Pipeline

| Stage | Model | Input → Output |
|-------|-------|----------------|
| **Translation & Analysis** | Gemini 2.5 Flash | Article content → `title_cn`, `summary`, `summary_cn`, `tags[]`, `keywords[]` |
| **Embedding** | BGE-M3 (1024d) | Title + summary + tags → dense vector for similarity search |
| **Topic Clustering** | Cosine similarity | Find articles > 0.85 similarity within 7 days → group under `topic_id` |
| **Topic Synthesis** | Gemini 2.5 Flash | Topic articles → headline + description (EN/繁中) |

## Stack

| Layer | Technology |
|-------|------------|
| Runtime | Cloudflare Workers (V8 isolates) |
| Orchestration | Cloudflare Queues + Workflows |
| Database | Supabase PostgreSQL + pgvector |
| LLM | OpenRouter → Gemini 2.5 Flash |
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
├── index.ts              # Entry — routes HTTP, Cron, Queue
├── app/
│   ├── http.ts           # POST /submit, GET /health
│   └── cron.ts           # RSS (*/5min), Twitter (*/6h)
├── domain/
│   ├── workflow.ts       # 7-step Workflow orchestration
│   ├── processors.ts     # AI processors (registry pattern)
│   ├── scrapers.ts       # Platform scrapers
│   └── topics.ts         # Topic clustering + synthesis
├── infra/
│   ├── ai.ts             # OpenRouter client
│   ├── embedding.ts      # Workers AI client
│   ├── db.ts             # Supabase client
│   └── web.ts            # HTTP utilities
└── models/
    └── types.ts          # Types & bindings
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
