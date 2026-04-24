<div align="center">

# newsence

**幫助 LLM 理解你的世界的內容發現引擎**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![npm: newsence](https://img.shields.io/npm/v/newsence?label=npm%3A%20newsence&color=cb3837&logo=npm)](https://www.npmjs.com/package/newsence)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?logo=anthropic&logoColor=white)](https://www.newsence.app/api/mcp)
[![Website](https://img.shields.io/badge/newsence.app-live-00c853)](https://www.newsence.app)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/newsence)

[English](README.md) | [繁體中文](README.zh-TW.md)

</div>

---

## newsence 是什麼？

[**newsence.app**](https://www.newsence.app) 的引擎。支援 RSS、Twitter、YouTube、HN、Bilibili、小紅書，自動中英雙語 AI 分析、Embedding 還有知識圖譜。遵循 [**LLM Wiki**](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 模式 — 每個來源讀一次就整合進一個持續成品（摘要、實體、embeddings、交叉引用），不是 query time 才做 RAG。

## 支援平台

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)
![Bilibili](https://img.shields.io/badge/Bilibili-00A1D6?logo=bilibili&logoColor=white)
![Xiaohongshu](https://img.shields.io/badge/Xiaohongshu-FF2442?logo=xiaohongshu&logoColor=white)

| 平台            | 類型   | 排程       | 說明                                             |
| --------------- | ------ | ---------- | ------------------------------------------------ |
| **RSS 訂閱**    | 監控   | 每 5 分鐘  | 抓取 feed、依 URL 去重、偵測 HN 連結             |
| **Twitter/X**   | 監控   | 每 6 小時  | 透過 Kaito API 追蹤用戶 — 推文、串文、長文、媒體 |
| **YouTube**     | 監控   | 每 30 分鐘 | Atom feed → 影片資訊、字幕、章節、AI 精華段落    |
| **Bilibili**    | 監控   | 每 30 分鐘 | gRPC 移動端 API → 用戶動態、影片卡片             |
| **小紅書**      | 監控   | 每 30 分鐘 | 用戶主頁抓取 → 筆記、封面                        |
| **Hacker News** | 處理器 | 經由 RSS   | 偵測 HN 連結 → Algolia 取評論 → 生成編輯筆記     |
| **網頁**        | 爬蟲   | 按需       | 全文擷取（Readability + Cheerio）、OG metadata   |
| **用戶投稿**    | 入口   | 即時       | `POST /submit` — 完整抓取 + workflow，同步回應   |

所有平台輸出統一的 `ScrapedContent` 格式 → 進入同一個 AI 管線。

## 運作流程

每篇文章經過自動化 workflow，各步驟獨立重試：

```
URL 進入（RSS 排程 / Twitter 排程 / YouTube 排程 / /submit）
  │
  ├─ 1. 讀取文章 ─────────── 從資料庫載入文章列
  ├─ 2. AI 分析 ──────────── Gemini Flash Lite → 中英標題、摘要、標籤、關鍵字、實體
  ├─ 3. 抓取 OG 圖片 ──────── 若缺少圖片則輕量抓取（僅前 32 KB）
  ├─ 4. 翻譯全文 ─────────── 全文 → 繁體中文
  ├─ 5. 存入資料庫 ────────── 單次 UPDATE 寫入所有 AI 結果
  ├─    同步實體 ─────────── （條件性）將實體寫入正規化表格，建立關聯
  ├─ 6. YouTube 精華 ─────── （僅 YouTube）從字幕生成 AI 精華段落
  └─ 7. 生成 Embedding ──── BGE-M3 → 1024 維向量（標題 + 摘要 + 全文 + 實體名稱）
```

每篇約 30 秒完成。每步獨立重試，指數退避。

## AI 管線

| 階段         | 模型              | 說明                                                        |
| ------------ | ----------------- | ----------------------------------------------------------- |
| **分析**     | Gemini Flash Lite | 文章 → 中英標題、摘要、標籤、關鍵字、分類                   |
| **實體提取** | Gemini Flash Lite | 文章 → 具名實體（人物、組織、產品、技術、事件），含中英名稱 |
| **全文翻譯** | Gemini Flash      | 全文內容 → 繁體中文                                         |
| **向量生成** | BGE-M3（1024 維） | 標題 + 摘要 + 全文 + 實體名稱 → 語意向量（HNSW 索引）       |

實體提取與分析在同一次 LLM 呼叫中完成 — 零額外 API 成本。

## 技術棧

| 層級         | 技術                                                |
| ------------ | --------------------------------------------------- |
| 運行環境     | Cloudflare Workers（V8 isolates）                   |
| 任務編排     | Cloudflare Queues + Workflows                       |
| 資料庫       | PostgreSQL + pgvector（透過 Cloudflare Hyperdrive） |
| 大語言模型   | OpenRouter → Gemini Flash / Flash Lite              |
| 向量生成     | Cloudflare Workers AI → BGE-M3                      |
| Twitter 數據 | Kaito API（第三方）                                 |

## 自行部署

上方的一鍵 Deploy 按鈕會幫你建好 Worker + Queue + Workflow，**但 Hyperdrive、資料庫、secrets 需要手動設定**。完整步驟：

### 1. 資料庫

需要一個裝了 pgvector 的 PostgreSQL。測試過 Supabase；任何 Postgres ≥ 15 + `vector` extension 都行。

需要的表：`articles`、`user_articles`、`RssList`、`youtube_transcripts`，以及 entity / citation 相關表格。完整 schema 定義在上層 monorepo 的 `frontend/prisma/schema.prisma` — 獨立的 `schema.sql` 還在 roadmap。目前可以參考 Prisma models，或在 Issues 聯絡我。

### 2. Hyperdrive binding

建一個 Hyperdrive 指向你的資料庫：

```bash
wrangler hyperdrive create newsence-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

把回傳的 ID 填進 `wrangler.jsonc` 的 `hyperdrive[].id` 欄位。

### 3. Cloudflare Queues + Workflow

建立 article-processing queue（Worker 同時當 producer 和 consumer）：

```bash
wrangler queues create article-processing-queue-core
wrangler queues create article-processing-dlq-core
```

Workflow 會在第一次 deploy 時透過 `wrangler.jsonc` 裡的 `workflows` binding 自動建立。

### 4. Secrets

只有 `OPENROUTER_API_KEY` 是必要的，其他都是啟用特定平台用的：

```bash
wrangler secret put OPENROUTER_API_KEY       # 必要 — AI 分析
wrangler secret put KAITO_API_KEY            # 可選 — Twitter 監控
wrangler secret put YOUTUBE_API_KEY          # 可選 — YouTube 監控
wrangler secret put CORE_WORKER_INTERNAL_TOKEN  # 可選 — /submit 驗證
```

### 5. 部署

```bash
pnpm install
pnpm run deploy
```

或本地跑 `pnpm dev`（用 `wrangler dev --test-scheduled`，可以 curl `/__scheduled?cron=*/5+*+*+*+*` 手動觸發 RSS cron）。

## API

```bash
# 健康檢查
curl https://your-worker.workers.dev/health

# 提交 URL
curl -X POST https://your-worker.workers.dev/submit \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article"}'

# 生成 Embedding
curl -X POST https://your-worker.workers.dev/embed \
  -H "Content-Type: application/json" \
  -d '{"text": "搜尋關鍵字"}'
```

<details>
<summary>回應範例</summary>

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

可選驗證：`X-Internal-Token` header。內建限流：每 key 20 次/60 秒（可透過 `SUBMIT_RATE_LIMIT_MAX` / `SUBMIT_RATE_LIMIT_WINDOW_SEC` 調整）。

## CLI 與 MCP 伺服器

也可以透過獨立的 [`newsence`](https://www.npmjs.com/package/newsence) npm 套件當 CLI 和 [MCP](https://modelcontextprotocol.io) server 使用：

```bash
npx newsence search "AI agents"       # 搜尋文章
npx newsence recent --hours 6         # 最近幾小時的文章

claude mcp add newsence -- npx newsence mcp   # 加入 Claude Code
# 遠端 MCP：https://www.newsence.app/api/mcp
```

## 架構

```
src/
├── index.ts              # 只保留 Cloudflare WorkerEntrypoint class
├── entrypoints/          # HTTP、scheduled、queue、RPC adapters
├── app/
│   ├── handlers/         # 薄 HTTP route handlers（/submit、/preview、/embed、/health）
│   ├── use-cases/        # HTTP + RPC 共用的 application actions
│   ├── monitors/         # 跨平台排程維護
│   └── workflows/        # Queue consumer、Workflow class、workflow steps
├── platforms/            # 每個平台一個資料夾
│   ├── registry.ts       # URL 偵測 dispatch → platform scraper
│   ├── twitter/          # monitor + scraper + processor + metadata
│   ├── youtube/          # monitor + scraper + highlights + metadata
│   ├── hackernews/       # scraper + processor + metadata（沒有 monitor — 由 RSS 觸發）
│   ├── bilibili/         # monitor + scraper + metadata
│   ├── xiaohongshu/      # monitor + scraper + metadata
│   ├── rss/              # monitor + parser + feed-config
│   └── web/              # 共用爬蟲（Readability + Cheerio + OG 擷取）
├── domain/
│   ├── content/          # 共用內容清理與 editorial domain helpers
│   ├── processing/       # AI processor registry、DefaultProcessor、AI helpers
│   └── entities.ts       # 實體同步至正規化表格
├── infra/
│   ├── db.ts             # Hyperdrive client + insertArticle / dedup / transcript helpers
│   ├── fetch.ts          # fetchWithTimeout
│   ├── log.ts            # 結構化 JSON 日誌
│   └── openrouter.ts     # OpenRouter + embedding wrappers
└── models/               # 型別 + PlatformMetadata 聯合型別
```

## 環境變數與 Bindings

Bindings（在 `wrangler.jsonc` 裡設定）：

| Binding            | 用途                                        |
| ------------------ | ------------------------------------------- |
| `HYPERDRIVE`       | 連線到你的 Postgres                         |
| `ARTICLE_QUEUE`    | `article-processing-queue-core` 的 producer |
| `MONITOR_WORKFLOW` | `NewsenceMonitorWorkflow` instance 建立     |
| `AI`               | Workers AI（BGE-M3 向量生成）               |
| `BROWSER`          | Cloudflare Browser Rendering（預留）        |

Secrets（透過 `wrangler secret put` 設定）：

| 變數                           | 必要 | 說明                          |
| ------------------------------ | ---- | ----------------------------- |
| `OPENROUTER_API_KEY`           | 是   | OpenRouter（Gemini）AI 分析用 |
| `CORE_WORKER_INTERNAL_TOKEN`   | 否   | `/submit` 端點的 bearer token |
| `KAITO_API_KEY`                | 否   | 啟用 Twitter 監控             |
| `YOUTUBE_API_KEY`              | 否   | 啟用 YouTube 頻道監控         |
| `SUBMIT_RATE_LIMIT_MAX`        | 否   | 限流次數上限（預設 20）       |
| `SUBMIT_RATE_LIMIT_WINDOW_SEC` | 否   | 限流視窗秒數（預設 60）       |

## 新增平台

平台目前是**鬆散的慣例**而不是正式的 interface — 每個平台資料夾裡會有 `monitor.ts`（定時抓取）、`scraper.ts`（URL 觸發）、`metadata.ts`（型別與 builder）的一些組合，可選 `processor.ts`（自訂 AI 分析）。不是每個平台四件都有；挑一個最接近的平台複製它的形狀。

新增一個來源最少要做：

1. **Scraper**（`platforms/foo/scraper.ts`）— export 一個回傳 `ScrapedContent` 的函式。
2. **Metadata**（`platforms/foo/metadata.ts`）— 定義 `FooMetadata` 型別和 `buildFoo(...)` 建構子；在 `models/platform-metadata.ts` 註冊。
3. **URL 偵測與 dispatch** — 把 URL pattern 加到 `models/scraped-content.ts:detectPlatformType`，並在 `platforms/registry.ts` 路由到 scraper。
4. **Monitor**（可選，`platforms/foo/monitor.ts`）— 如果來源可以輪詢，照現有 cron handler 改一份；在 `entrypoints/scheduled.ts` 裡接上。
5. **Processor**（可選，`platforms/foo/processor.ts`）— 只有在你需要不同於 `DefaultProcessor` 的 AI 行為時才寫；在 `domain/processing/processors.ts` 註冊。

新文章一樣走 Queue → Workflow pipeline，AI 步驟你不用動。

## 授權

MIT
