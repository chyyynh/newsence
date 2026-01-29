# Newsence Core Worker

統一的 Cloudflare Worker，負責內容聚合、AI 分析、翻譯與 embedding 生成。

**URL:** `https://newsence-core.chinyuhsu1023.workers.dev`

## 功能

- RSS 監控與抓取
- Twitter 高互動推文追蹤
- 多平台 Scraping (YouTube/Twitter/HackerNews/Web)
- AI 翻譯與摘要 (Gemini 2.5 Flash)
- Embedding 生成 (BGE-M3)
- Queue 異步處理
- Workflow 編排

## 專案結構

```
src/
├── index.ts          # 入口 - HTTP/Cron/Queue 路由
├── types.ts          # 型別定義
├── handlers.ts       # HTTP 端點處理
├── cron.ts           # 定時任務 (RSS/Twitter/Daily)
├── queue.ts          # Queue 消費者
├── workflow.ts       # Workflow 編排
├── processors.ts     # 平台處理器 (Default/Twitter/HN)
├── scrapers.ts       # 平台抓取器 (YouTube/Twitter/HN/Web)
└── utils/
    ├── ai.ts         # OpenRouter AI 分析
    ├── embedding.ts  # Workers AI embedding
    ├── supabase.ts   # Supabase 客戶端
    ├── rss.ts        # RSS 解析與內容抓取
    └── platform.ts   # 平台偵測與 metadata
```

## HTTP 端點

| Method | Path | 說明 |
|--------|------|------|
| GET | `/health` | 健康檢查 |
| GET | `/status` | Worker 狀態 |
| POST | `/trigger` | 手動觸發文章處理 |
| POST | `/submit` | 提交 URL (輕量) |
| POST | `/scrape` | Scrape URL (完整 AI 處理) |
| GET | `/api/youtube/metadata` | YouTube metadata |
| POST | `/cron/rss` | 手動觸發 RSS 監控 |
| POST | `/cron/twitter` | 手動觸發 Twitter 監控 |
| POST | `/cron/article-daily` | 手動觸發每日處理 |

## Scrape API

```bash
curl -X POST https://newsence-core.chinyuhsu1023.workers.dev/scrape \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article"}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "articleId": "uuid",
    "url": "https://example.com/article",
    "title": "Article Title",
    "titleCn": "文章標題",
    "summary": "English summary...",
    "summaryCn": "中文摘要...",
    "sourceType": "web",
    "ogImageUrl": "https://...",
    "tags": ["tag1", "tag2"],
    "metadata": {}
  }
}
```

## 定時任務

| Cron | 任務 | 說明 |
|------|------|------|
| `*/5 * * * *` | RSS Monitor | 每 5 分鐘抓取 RSS feeds |
| `0 */6 * * *` | Twitter Monitor | 每 6 小時追蹤高互動推文 |
| `0 3 * * *` | Article Daily | 每日 3AM 處理未完成文章 |

## Queue 系統

| Queue | 訊息類型 | 用途 |
|-------|---------|------|
| `rss-scraping-queue-core` | `article_scraped` | RSS 文章 |
| `twitter-processing-queue-core` | `tweet_scraped` | Twitter 推文 |
| `article-processing-queue-core` | `process_articles` | AI 分析 |

配置：
- `max_batch_size`: 10
- `max_batch_timeout`: 30s
- `max_retries`: 3

## 平台支援

| 平台 | 偵測 | Metadata |
|------|------|----------|
| YouTube | `youtube.com`, `youtu.be` | 影片資訊、字幕、章節 |
| Twitter | `twitter.com`, `x.com` | 推文、互動數據、Article |
| HackerNews | `news.ycombinator.com` | 討論、評論摘要 |
| Web | 其他 | OG metadata、內容 |

## AI 處理

### 分析 (OpenRouter)
- **Model:** `google/gemini-2.5-flash-preview-05-20`
- **輸出:** tags, keywords, summary_en, summary_cn, title_cn

### Embedding (Workers AI)
- **Model:** `@cf/baai/bge-m3`
- **維度:** 1024
- **輸入:** title + title_cn + summary + summary_cn + tags

## 環境變數

| 變數 | 必要 | 說明 |
|------|------|------|
| `SUPABASE_URL` | Yes | Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase key |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `ARTICLES_TABLE` | No | Table 名稱 (預設: `articles`) |
| `YOUTUBE_API_KEY` | No | YouTube Data API |
| `KAITO_API_KEY` | No | Kaito API (Twitter) |
| `TRANSCRIPT_API_KEY` | No | Transcript API |

## 開發

```bash
# 安裝
pnpm install

# 本地開發
pnpm dev

# TypeScript 檢查
pnpm exec tsc --noEmit

# 部署
pnpm run deploy

# 查看 logs
pnpm wrangler tail
```

## 資料流

```
┌─────────────────────────────────────────────────────────┐
│                    資料來源                              │
│  RSS Feeds  │  Twitter Lists  │  Manual URL  │  Webhook │
└──────┬──────┴────────┬────────┴───────┬──────┴─────┬────┘
       │               │                │            │
       ▼               ▼                ▼            │
  ┌─────────┐    ┌──────────┐    ┌──────────┐       │
  │RSS Cron │    │Twitter   │    │ /scrape  │       │
  │ */5min  │    │ */6h     │    │ /submit  │       │
  └────┬────┘    └────┬─────┘    └────┬─────┘       │
       │              │               │             │
       └──────────────┼───────────────┘             │
                      ▼                             │
         ┌────────────────────────┐                 │
         │ Platform Scraper       │◄────────────────┘
         │ (YouTube/Twitter/HN)   │
         └───────────┬────────────┘
                     ▼
         ┌────────────────────────┐
         │ Save to Supabase       │
         └───────────┬────────────┘
                     ▼
         ┌────────────────────────┐
         │ Queue Message          │
         └───────────┬────────────┘
                     ▼
         ┌────────────────────────┐
         │ Workflow Orchestrator  │
         └───────────┬────────────┘
                     ▼
         ┌────────────────────────┐
         │ AI Analysis (Gemini)   │
         │ → 翻譯、標籤、摘要      │
         └───────────┬────────────┘
                     ▼
         ┌────────────────────────┐
         │ Embedding (BGE-M3)     │
         │ → 1024 維向量          │
         └───────────┬────────────┘
                     ▼
         ┌────────────────────────┐
         │ Update Supabase        │
         └────────────────────────┘
```
