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
├── index.ts              # 入口 - HTTP/Cron/Queue 路由
├── app/
│   ├── http.ts           # HTTP 端點處理
│   └── schedule.ts       # 定時任務 (RSS/Twitter)
├── domain/
│   ├── workflow.ts       # Workflow + Queue 消費者
│   ├── processors.ts     # 平台處理器 + 共用處理流程
│   └── scrapers.ts       # 平台抓取器 (YouTube/Twitter/HN/Web)
├── infra/
│   ├── ai.ts             # OpenRouter AI 分析
│   ├── embedding.ts      # Workers AI embedding
│   ├── db.ts             # Supabase 客戶端
│   ├── web.ts            # 網頁抓取與 URL 工具
│   └── platform.ts       # 平台 metadata 抓取
└── models/
    └── types.ts          # 型別定義
```

## HTTP 端點

| Method | Path | 說明 |
|--------|------|------|
| GET | `/health` | 健康檢查 |
| POST | `/submit` | 提交 URL (完整 crawl + AI 處理) |

## Submit API

```bash
curl -X POST https://newsence-core.chinyuhsu1023.workers.dev/submit \
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

## Queue 系統

| Queue | 訊息類型 | 用途 |
|-------|---------|------|
| `article-processing-queue-core` | `article_process` / `batch_process` | 觸發 Workflow 進行 AI 分析與 embedding |

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
| `CORE_WORKER_INTERNAL_TOKEN` | No | 啟用 `/submit` 驗證用的內部 token (header: `X-Internal-Token`) |
| `SUBMIT_RATE_LIMIT_MAX` | No | `/submit` 單一 key 於時間窗內最大請求數 (預設: `20`) |
| `SUBMIT_RATE_LIMIT_WINDOW_SEC` | No | `/submit` 限流時間窗秒數 (預設: `60`) |
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
  │RSS Cron │    │Twitter   │    │ /submit  │       │
  │ */5min  │    │ */6h     │    │   API    │       │
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
