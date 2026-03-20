# newsence

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![npm: newsence](https://img.shields.io/npm/v/newsence?label=npm%3A%20newsence&color=cb3837&logo=npm)](https://www.npmjs.com/package/newsence)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?logo=anthropic&logoColor=white)](https://www.newsence.app/api/mcp)
[![Website](https://img.shields.io/badge/newsence.app-live-00c853)](https://www.newsence.app)

> **[newsence.app](https://www.newsence.app)** is an open-source, AI-powered news intelligence platform. It monitors 100+ sources across RSS, Twitter, YouTube, and Hacker News — translating every article into bilingual summaries (EN/繁中), generating semantic embeddings for search, and clustering breaking stories into topics, all in real time.

---

## What happens when an article arrives

Each article goes through a 7-step workflow, fully automated with independent retries:

```
URL arrives (RSS cron / Twitter cron / user submit / Telegram bot)
  │
  ├─ 1. Scrape ─────────── Platform-aware crawler extracts content, metadata, OG image
  ├─ 2. AI Analysis ────── Gemini 2.5 Flash generates bilingual title, summary, tags, keywords
  ├─ 3. Save to DB ─────── Write translations + metadata to Supabase PostgreSQL
  ├─ 4. Embed ──────────── BGE-M3 generates 1024-dim semantic vector via Workers AI
  ├─ 5. Save Embedding ─── Store vector for pgvector similarity search
  ├─ 6. Topic Clustering ─ Find similar articles (cosine > 0.85), assign to topic group
  └─ 7. Topic Synthesis ── When topic reaches 2/3/5/10 articles, AI generates a topic headline
```

Average processing time: ~30 seconds per article. Each step retries independently (x3, exponential backoff).

## Ingestion Sources

| Source | Schedule | How it works |
|--------|----------|--------------|
| **RSS Feeds** | Every 5 min | Cron fetches all feeds in `RssList`, deduplicates by URL, saves new articles |
| **Twitter Lists** | Every 6 hours | Cron pulls high-engagement tweets via Kaito API, extracts threads & media |
| **User Submissions** | Real-time | `POST /submit` — full crawl + AI inline, returns result synchronously |
| **Telegram Bot** | Real-time | Users send URLs in chat → calls Core `/submit` → replies with summary |

## Platform-Specific Scrapers

Not all content is the same. Each platform gets a specialized scraper:

| Platform | Detection | What it extracts |
|----------|-----------|------------------|
| **YouTube** | `youtube.com`, `youtu.be` | Video metadata, auto-generated captions, chapters, thumbnails |
| **Twitter/X** | `twitter.com`, `x.com` | Tweet text, thread reconstruction, engagement metrics, media URLs |
| **Hacker News** | `news.ycombinator.com` | Original article + HN discussion context via Algolia API |
| **Web** (default) | Everything else | Full article content via Cheerio, OG metadata, author, publish date |

All scrapers output a unified `ScrapedContent` shape that feeds into the same AI pipeline.

## AI Processing

**Translation & Analysis** (OpenRouter → Gemini 2.5 Flash):
- Input: scraped article content
- Output: `title_cn`, `summary` (EN), `summary_cn` (繁中), `tags[]`, `keywords[]`
- Platform-specific processors customize prompts (e.g., HN processor includes discussion context, Twitter processor handles thread formatting)

**Embedding Generation** (Workers AI → BGE-M3):
- Input: concatenated `title + title_cn + summary + summary_cn + tags`
- Output: 1024-dimensional dense vector
- Stored in Supabase with pgvector for similarity search

**Topic Clustering**:
- After embedding, searches for articles within 7 days with cosine similarity > 0.85
- Groups matching articles under a shared `topic_id`
- When a topic accumulates 2, 3, 5, or 10 articles, triggers AI synthesis to generate a headline that captures the full story arc

## Architecture

```
src/
├── index.ts              # Entry — routes HTTP, Cron, Queue events
├── app/
│   ├── http.ts           # POST /submit, GET /health
│   └── cron.ts           # RSS monitor (*/5min), Twitter monitor (*/6h)
├── domain/
│   ├── workflow.ts       # Queue consumer + 7-step Workflow orchestration
│   ├── processors.ts     # Platform-specific AI processors (registry pattern)
│   ├── scrapers.ts       # Platform scrapers (YouTube/Twitter/HN/Web)
│   └── topics.ts         # Topic clustering + AI synthesis
├── infra/
│   ├── ai.ts             # OpenRouter client
│   ├── embedding.ts      # Workers AI embedding client
│   ├── db.ts             # Supabase client
│   └── web.ts            # HTTP utilities, URL normalization
└── models/
    └── types.ts          # Type definitions, Env bindings
```

## Stack

- **Runtime**: Cloudflare Workers (V8 isolates)
- **Orchestration**: Cloudflare Queues + Workflows (durable, auto-retry)
- **Database**: Supabase PostgreSQL + pgvector
- **LLM**: OpenRouter → Gemini 2.5 Flash
- **Embeddings**: Cloudflare Workers AI → BGE-M3 (1024 dims)
- **Twitter Data**: Kaito API (`api.twitterapi.io`)

## Getting Started

```bash
pnpm install
cp wrangler.jsonc.example wrangler.jsonc   # Add your API keys
pnpm dev                                    # Local dev server
pnpm run deploy                             # Deploy to Cloudflare
```

## API

```bash
# Health check
GET /health

# Submit a URL for processing (sync — returns full result)
POST /submit
Content-Type: application/json
{"url": "https://example.com/article"}

# Response
{
  "success": true,
  "results": [{
    "articleId": "uuid",
    "title": "Article Title",
    "sourceType": "web",
    "alreadyExists": false
  }]
}
```

Optional auth via `X-Internal-Token` header. Built-in rate limiting: 20 requests per 60s per key (configurable).

## CLI & MCP Server

Also available as a CLI tool and MCP server via the [`newsence`](https://www.npmjs.com/package/newsence) npm package:

```bash
# Search from terminal
npx newsence search "AI agents"
npx newsence recent --hours 6

# Add as MCP server for Claude Code
claude mcp add newsence -- npx newsence mcp

# Remote MCP endpoint for Claude Cowork
# https://www.newsence.app/api/mcp
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key (Gemini 2.5 Flash) |
| `CORE_WORKER_INTERNAL_TOKEN` | No | Auth token for `/submit` endpoint |
| `YOUTUBE_API_KEY` | No | YouTube Data API key |
| `KAITO_API_KEY` | No | Kaito API key (Twitter data) |
| `TRANSCRIPT_API_KEY` | No | YouTube transcript API key |

## License

MIT
