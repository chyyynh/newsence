# Newsence Core Worker

A Cloudflare Worker for content aggregation and AI-powered article analysis. It monitors RSS feeds, Twitter, HackerNews, YouTube, and WebSocket sources, then processes articles with AI analysis and vector embeddings.

## Architecture Overview

```
Data Sources (RSS/Twitter/WebSocket)
    ↓
Cron Jobs (Monitors) / Manual Triggers
    ↓
HTTP Endpoints (Handlers)
    ↓
Queues (Async Processing)
    ↓
Workflow Orchestrator
    ↓
Article Processing (AI Analysis + Platform Detection)
    ↓
Supabase Database & Embedding Storage
```

## Project Structure

```
src/
├── index.ts                    # Main entry point - HTTP/Scheduled/Queue handlers
├── types.ts                    # Type definitions
├── handlers/
│   ├── health.ts               # GET /health
│   ├── status.ts               # GET /status
│   ├── trigger.ts              # POST /trigger - Manual article processing
│   └── webhook.ts              # POST /webhook - WebSocket messages
├── cron/
│   ├── rss-monitor.ts          # RSS feed monitoring (every 5 min)
│   ├── twitter-monitor.ts      # Twitter monitoring (every 6 hours)
│   └── article-daily.ts        # Daily article processing (3 AM)
├── processors/
│   ├── types.ts                # Processor interface definitions
│   ├── base.ts                 # DefaultProcessor + OpenRouter utilities
│   ├── index.ts                # Processor factory
│   ├── hackernews.ts           # HackerNews-specific processing
│   └── twitter.ts              # Twitter-specific processing
├── queue/
│   ├── rss-consumer.ts         # RSS queue consumer
│   ├── twitter-consumer.ts     # Twitter queue consumer
│   ├── article-consumer.ts     # Article processing queue consumer
│   └── utils.ts                # Shared queue handling & workflow trigger
├── workflow/
│   └── orchestrator.ts         # NewsenceMonitorWorkflow definition
└── utils/
    ├── ai.ts                   # OpenRouter AI analysis & translation
    ├── embedding.ts            # Workers AI embeddings (BGE-M3)
    ├── supabase.ts             # Supabase client initialization
    ├── rss.ts                  # URL normalization, content scraping, OG images
    ├── platform-detection.ts   # Platform type & ID extraction
    ├── platform-metadata.ts    # Platform-specific metadata fetching
    └── telegram.ts             # Telegram notifications
```

## HTTP Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check with timestamp |
| GET | `/status` | Worker version and features |
| POST | `/trigger` | Manual article processing trigger |
| POST | `/webhook` | Receive WebSocket-forwarded messages |
| POST | `/cron/rss` | Manual RSS monitor trigger |
| POST | `/cron/twitter` | Manual Twitter monitor trigger |
| POST | `/cron/article-daily` | Manual daily processing trigger |

### Manual Trigger Example

```bash
# Process specific articles
curl -X POST https://newsence-core-test.chinyuhsu1023.workers.dev/trigger \
  -H "Content-Type: application/json" \
  -d '{"article_ids": ["uuid-1", "uuid-2"], "triggered_by": "manual"}'

# Process all unprocessed articles from last 24h
curl -X POST https://newsence-core-test.chinyuhsu1023.workers.dev/trigger
```

## Cron Jobs

| Schedule | Handler | Description |
|----------|---------|-------------|
| `*/5 * * * *` | `handleRSSCron` | Fetch and process RSS feeds |
| `0 */6 * * *` | `handleTwitterCron` | Monitor high-view tweets via Kaito API |
| `0 3 * * *` | `handleArticleDailyCron` | Process articles missing tags/summaries |

## Queue System

Three specialized queues manage async processing:

| Queue | Message Type | Purpose |
|-------|-------------|---------|
| `rss-scraping-queue-core` | `article_scraped` | RSS/general articles |
| `twitter-processing-queue-core` | `tweet_scraped` | Twitter/tweets |
| `article-processing-queue-core` | `process_articles` | AI analysis & embedding |

All queues configured with:
- `max_batch_size`: 10
- `max_batch_timeout`: 30s
- `max_retries`: 3
- Dead letter queues for failed messages

## Processors

### DefaultProcessor (base.ts)
- Used for general RSS articles
- Calls Gemini 2.5 Flash for analysis
- Extracts: tags, keywords, summaries (EN/CN), title translations

### HackerNewsProcessor (hackernews.ts)
- Fetches full HN discussion from Algolia API
- AI-summarizes comments (150-200 words)
- Stores enrichments: `discussionSummary`, `hnUrl`, `externalUrl`

### TwitterProcessor (twitter.ts)
- Uses tweet text as summary
- Translates to Chinese
- Extracts tags/keywords from tweet analysis

## AI & Embedding

### AI Analysis (`utils/ai.ts`)
- **Model**: OpenRouter → `google/gemini-2.5-flash-lite`
- **Temperature**: 0.3
- **Timeout**: 30 seconds
- **Output**: tags, keywords, summaries (EN/CN), title translations

### Embedding (`utils/embedding.ts`)
- **Model**: `@cf/baai/bge-m3` (Workers AI)
- **Dimensions**: 1024
- **Input**: title + title_cn + summary + summary_cn + tags + keywords
- **Max text length**: 8000 characters

## Platform Detection & Metadata

### Supported Platforms
| Platform | Detection | Metadata Source |
|----------|-----------|-----------------|
| HackerNews | `news.ycombinator.com` | HN Algolia API |
| YouTube | `youtube.com`, `youtu.be` | YouTube Data API |
| Twitter | `twitter.com`, `x.com` | Kaito API |
| ArXiv | `arxiv.org` | XML metadata |

### Metadata Enrichment
- **YouTube**: videoId, channelName, duration, thumbnail, viewCount, description
- **HackerNews**: author, points, commentCount, itemType
- **Twitter**: authorName, authorVerified, metrics, mediaUrls

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for Gemini |
| `ARTICLES_TABLE` | No | Table name (default: `articles_test_core`) |
| `KAITO_API_KEY` | No | Kaito API for Twitter metadata |
| `YOUTUBE_API_KEY` | No | YouTube Data API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID for notifications |

## Database Schema

### Articles Table
```sql
id              UUID PRIMARY KEY
url             TEXT UNIQUE
title           TEXT
title_cn        TEXT
summary         TEXT
summary_cn      TEXT
content         TEXT
source          TEXT
source_type     TEXT
published_date  TIMESTAMP
scraped_date    TIMESTAMP
tags            TEXT[]
keywords        TEXT[]
og_image_url    TEXT
platform_metadata JSONB
embedding       VECTOR(1024)
```

### Platform Metadata Structure
```json
{
  "type": "hackernews" | "youtube" | "twitter" | "websocket",
  "fetchedAt": "ISO timestamp",
  "data": { /* platform-specific data */ },
  "enrichments": {
    "discussionSummary": "...",
    "processedAt": "ISO timestamp"
  }
}
```

## Workflow Orchestration

The `NewsenceMonitorWorkflow` manages article processing:

1. **log-workflow-start**: Record execution start
2. **send-to-processing-queue**: Route articles to ARTICLE_QUEUE (with retries)
3. **log-workflow-completion**: Record execution completion

## Development

```bash
# Install dependencies
pnpm install

# Local development with scheduled triggers
pnpm dev --test-scheduled

# Type checking
pnpm tsc --noEmit

# Run tests
pnpm test

# Deploy
pnpm wrangler deploy

# Generate types from wrangler config
pnpm cf-typegen
```

## Logging Convention

All log messages use prefixes for easy filtering:

| Prefix | Component |
|--------|-----------|
| `[CORE]` | Main worker entry |
| `[RSS]` | RSS monitor |
| `[TWITTER]` | Twitter monitor |
| `[WEBHOOK]` | WebSocket messages |
| `[TRIGGER]` | Manual triggers |
| `[WORKFLOW]` | Workflow execution |
| `[ARTICLE]` | Article processing |
| `[AI]` | AI analysis |
| `[HN-PROCESSOR]` | HackerNews processing |
| `[Embedding]` | Vector generation |
| `[PLATFORM-METADATA]` | Metadata fetching |
| `[TELEGRAM]` | Telegram notifications |

## Error Handling

- **Queue Retries**: 3 retries with exponential backoff
- **Workflow Retries**: 3 retries with 30-second delays
- **Processing Timeout**: 5 minutes
- **AI Timeout**: 30 seconds per call
- **Dead Letter Queues**: Failed messages routed for manual inspection

## System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    EXTERNAL DATA SOURCES                         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  ┌──────────┐  │
│  │  RSS Feeds  │  │  Twitter API │  │ Webhooks │  │ YouTube  │  │
│  └──────┬──────┘  └──────┬───────┘  └────┬─────┘  └────┬─────┘  │
└─────────┼────────────────┼───────────────┼─────────────┼────────┘
          │                │               │             │
          ▼                ▼               ▼             │
    ┌──────────┐     ┌──────────┐    ┌──────────┐       │
    │ RSS Cron │     │ Twitter  │    │ Webhook  │       │
    │  */5min  │     │  */6h    │    │ Handler  │       │
    └────┬─────┘     └────┬─────┘    └────┬─────┘       │
         │                │               │             │
         └────────┬───────┴───────┬───────┘             │
                  ▼               ▼                     │
         ┌────────────────────────────────┐             │
         │ Platform Detection & Metadata  │◄────────────┘
         │ (HN Algolia, YouTube API, etc) │
         └────────────────┬───────────────┘
                          ▼
         ┌────────────────────────────────┐
         │ Content Scraping & OG Images   │
         └────────────────┬───────────────┘
                          ▼
         ┌────────────────────────────────┐
         │ Insert to Supabase             │
         └────────────────┬───────────────┘
                          ▼
         ┌────────────────────────────────┐
         │ Queue Messages                 │
         │ (RSS/Twitter → Article Queue)  │
         └────────────────┬───────────────┘
                          ▼
         ┌────────────────────────────────┐
         │ MONITOR_WORKFLOW Orchestrator  │
         └────────────────┬───────────────┘
                          ▼
         ┌────────────────────────────────┐
         │ Article Processing Consumer    │
         │ (Processor Selection)          │
         └────────────────┬───────────────┘
                          ▼
         ┌────────────────────────────────┐
         │ AI Analysis (Gemini 2.5 Flash) │
         │ → tags, keywords, summaries    │
         └────────────────┬───────────────┘
                          ▼
         ┌────────────────────────────────┐
         │ Embedding Generation (BGE-M3)  │
         │ → 1024-dim vectors             │
         └────────────────┬───────────────┘
                          ▼
         ┌────────────────────────────────┐
         │ Update Supabase                │
         │ (fields + enrichments + embed) │
         └────────────────────────────────┘
```

## Integrations

| Service | Purpose | API |
|---------|---------|-----|
| Supabase | Database & embeddings | REST API |
| OpenRouter | AI analysis | Gemini 2.5 Flash Lite |
| Workers AI | Text embeddings | BGE-M3 model |
| YouTube | Video metadata | Data API v3 |
| Kaito | Twitter metadata | twitterapi.io |
| HN Algolia | Discussion data | Public API |
| Telegram | Notifications | Bot API |
