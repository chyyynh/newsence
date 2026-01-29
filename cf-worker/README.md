# Cloudflare Workers

Cloudflare Workers for Newsence - content aggregation and AI-powered article processing.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           DATA SOURCES                                  │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐           │
│  │ RSS Feeds │  │  Twitter  │  │  YouTube  │  │ HackerNews│           │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘           │
└────────┼──────────────┼──────────────┼──────────────┼──────────────────┘
         │              │              │              │
         ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CORE WORKER                                     │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                        INGESTION                                  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐         │  │
│  │  │ RSS Cron │  │ Twitter  │  │ /scrape  │  │ /submit  │         │  │
│  │  │  */5min  │  │  */6h    │  │   API    │  │   API    │         │  │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘         │  │
│  └───────┼─────────────┼─────────────┼─────────────┼────────────────┘  │
│          │             │             │             │                    │
│          ▼             ▼             │             ▼                    │
│  ┌────────────────────────┐         │   ┌────────────────────────┐     │
│  │      Save to DB        │         │   │      Save to DB        │     │
│  │  (raw article/tweet)   │         │   │   (raw article)        │     │
│  └───────────┬────────────┘         │   └───────────┬────────────┘     │
│              │                      │               │                  │
│              ▼                      │               ▼                  │
│  ┌────────────────────────┐         │   ┌────────────────────────┐     │
│  │    ARTICLE_QUEUE       │         │   │    ARTICLE_QUEUE       │     │
│  │  { article_process }   │         │   │  { article_process }   │     │
│  └───────────┬────────────┘         │   └───────────┬────────────┘     │
│              │                      │               │                  │
│              ▼                      │               ▼                  │
│  ┌──────────────────────────────────┼───────────────────────────────┐  │
│  │         WORKFLOW (per article)   │                                │  │
│  │                                  │                                │  │
│  │  Step 1: fetch-article        (read from DB, retry x3)          │  │
│  │  Step 2: ai-analysis          (translate/tags/summary, retry x3)│  │
│  │  Step 3: update-db            (write results to DB, retry x3)   │  │
│  │  Step 4: generate-embedding   (Workers AI BGE-M3, retry x3)    │  │
│  │  Step 5: save-embedding       (write vector to DB, retry x3)   │  │
│  │                                  │                                │  │
│  └──────────────────────────────────┼───────────────────────────────┘  │
│                                     │                                  │
│                            /scrape does AI +                           │
│                            embedding inline                            │
│                            (no queue/workflow)                          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        TELEGRAM BOT                                     │
│                    User URL Submission                                  │
│                  Calls Core /scrape API                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## Processing Flows

### RSS / Twitter / Submit (async, via Queue + Workflow)

```
Cron or API → Scrape content → Save raw article to DB
  → ARTICLE_QUEUE { type: 'article_process', article_id, source_type }
    → Workflow instance (1 per article, CF auto-schedules)
      → Step 1: fetch-article        (DB read)
      → Step 2: ai-analysis          (Gemini 2.5 Flash)
      → Step 3: update-db            (translations, tags, keywords)
      → Step 4: generate-embedding   (BGE-M3 1024d)
      → Step 5: save-embedding       (vector to DB)
```

Each step retries independently x3 with exponential backoff.

### Scrape API (sync, inline)

```
POST /scrape → Scrape content → AI analysis → Save to DB → Embedding → Return result
```

No queue or workflow — full processing inline, returns complete result to caller.

## Workers

```
cf-worker/
├── core/             # Main worker - content aggregation + AI processing
├── telegram-bot/     # Telegram bot - URL submission via chat
├── embedding-proxy/  # Embedding proxy service
└── imageproxy/       # Image proxy service
```

### Core Worker

Unified content processing service:

| Feature | Description |
|---------|-------------|
| RSS Monitor | Fetch RSS feeds every 5 minutes |
| Twitter Monitor | Track high-engagement tweets every 6 hours |
| Scrape API | Full scraping with AI translation for any URL |
| AI Processing | Translation, tagging, summarization (Gemini 2.5 Flash) |
| Embeddings | Vector generation (BGE-M3, 1024 dims) |
| Queue | Single `ARTICLE_QUEUE` for all async processing |
| Workflow | Per-article 5-step pipeline with independent retry |

**URL:** `https://newsence-core.chinyuhsu1023.workers.dev`

### Telegram Bot

Receives URLs from users, calls Core's `/scrape` API, returns Chinese title + summary + OG image.

**URL:** `https://newsence-telegram-bot.chinyuhsu1023.workers.dev`

## Quick Start

```bash
cd core
pnpm install
pnpm dev          # Local development
pnpm run deploy   # Deploy to Cloudflare
pnpm wrangler tail # View logs
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key (Gemini) |
| `YOUTUBE_API_KEY` | No | YouTube Data API key |
| `KAITO_API_KEY` | No | Kaito API key (Twitter) |
| `TRANSCRIPT_API_KEY` | No | Transcript API key (YouTube captions) |

## Queue

| Queue | Purpose |
|-------|---------|
| `article-processing-queue-core` | All article processing (RSS, Twitter, submit, manual trigger) |
| `article-processing-dlq-core` | Dead letter queue |

## API Endpoints

### Core Worker

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Worker status |
| POST | `/scrape` | Scrape URL with full AI processing (sync) |
| POST | `/submit` | Submit URL → DB + queue for async processing |
| POST | `/trigger` | Manual batch processing for specific article IDs |
| GET | `/api/youtube/metadata` | YouTube metadata only |
| POST | `/cron/rss` | Manually trigger RSS cron |
| POST | `/cron/twitter` | Manually trigger Twitter cron |
| POST | `/cron/article-daily` | Manually trigger daily catch-up processing |
