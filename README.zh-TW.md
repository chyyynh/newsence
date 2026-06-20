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
| **用戶上傳**    | 入口   | 即時       | `POST /ingest` — URL / 圖片 / blob ingest，回傳資源與 workflow id |

所有平台輸出統一的 `ScrapedContent` 格式 → 進入同一個 AI 管線。

## 運作流程

每篇文章經過自動化 workflow，各步驟獨立重試：

```
內容進入（source monitor / user upload / retry）
  │
  ├─ 1. 讀取內容 ─────────── source draft 從 R2 載入；upload/retry 則讀既有 row
  ├─ 2. AI 分析 ──────────── Workers AI Qwen3 → 中英標題、摘要、標籤、關鍵字、實體
  ├─ 3. 抓取 OG 圖片 ──────── 若缺少圖片則輕量抓取（僅前 32 KB）
  ├─ 4. 存入資料庫 ────────── source 單次 final INSERT；row-based 單次 final UPDATE
  ├─    同步實體 ─────────── （條件性）將實體寫入正規化表格，建立關聯
  ├─ 5. YouTube 精華 ─────── （僅 YouTube）從字幕生成 AI 精華段落
  └─ 7. 生成 Embedding ──── BGE-M3 → 1024 維向量（標題 + 摘要 + 全文 + 實體名稱）
```

每篇約 30 秒完成。每步獨立重試，指數退避。

## AI 管線

| 階段         | 模型              | 說明                                                        |
| ------------ | ----------------- | ----------------------------------------------------------- |
| **分析**     | Workers AI Qwen3 | 文章 → 中英標題、摘要、標籤、關鍵字、分類                   |
| **實體提取** | Workers AI Qwen3 | 文章 → 具名實體（人物、組織、產品、技術、事件），含中英名稱 |
| **向量生成** | BGE-M3（1024 維） | 標題 + 摘要 + 全文 + 實體名稱 → 語意向量（HNSW 索引）       |

翻譯/摘要與分類/實體是分開的 structured calls，避免其中一個 schema 失敗就讓整篇文章落入 fallback。

## 技術棧

| 層級         | 技術                                                |
| ------------ | --------------------------------------------------- |
| 運行環境     | Cloudflare Workers（V8 isolates）                   |
| 任務編排     | Cloudflare Queues + Workflows                       |
| 資料庫       | PostgreSQL + pgvector（透過 Cloudflare Hyperdrive） |
| 大語言模型   | Cloudflare Workers AI → Qwen3                       |
| 向量生成     | Cloudflare Workers AI → BGE-M3                      |
| Twitter 數據 | Kaito API（第三方）                                 |

## 自行部署

上方的一鍵 Deploy 按鈕會幫你建好 Worker + Queue + Workflow，**但 Hyperdrive、資料庫、secrets 需要手動設定**。完整步驟：

### 1. 資料庫

需要一個裝了 pgvector 的 PostgreSQL。目前跑在 PlanetScale Postgres（透過 Cloudflare Hyperdrive）；任何 Postgres ≥ 15 + `vector` extension 都行。

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

AI 分析與向量生成都走 Workers AI binding，不需要外部 LLM secret。其他 secrets 是啟用特定平台用的：

```bash
wrangler secret put KAITO_API_KEY            # 可選 — Twitter 監控
wrangler secret put YOUTUBE_API_KEY          # 可選 — YouTube 監控
wrangler secret put CORE_WORKER_INTERNAL_TOKEN  # internal HTTP endpoints 驗證
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

# Ingest URLs
curl -X POST https://your-worker.workers.dev/ingest \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $CORE_WORKER_INTERNAL_TOKEN" \
  -d '{"urls": ["https://example.com/article"], "userId": "user-id"}'

```

<details>
<summary>回應範例</summary>

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

驗證：internal endpoints 需要 `X-Internal-Token` 或 `Authorization: Bearer`。用戶 ingest 由 `wrangler.jsonc` 的 `USER_INGEST_LIMITER` binding 限流。

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
├── entrypoints/          # HTTP router + scheduled + queue dispatch、health
├── shared/               # 跨子系統共用基礎 — 下面兩條 pipeline 都用
│   ├── auth/             # /ingest、/search、/media/* internal-token middleware
│   ├── ai.ts             # Workers AI 文字 + JSON helpers
│   ├── db.ts             # Hyperdrive clients + article/user_file helpers
│   ├── embedding.ts      # BGE-M3 wrapper（Workers AI）
│   ├── platform-metadata.ts  # PlatformMetadata 聯合型別 + builders
│   ├── scraped-content.ts    # 統一的 ScrapedContent 格式 + detectPlatformType
│   └── …                 # fetch、web、mime、streams、log、cors、types
├── ingest/               # ── 文章入庫 pipeline（開源核心）──
│   ├── platforms/        # 每個平台一個資料夾
│   │   ├── registry.ts   # URL 偵測 dispatch → platform scraper
│   │   ├── twitter/      # monitor + scraper + processor + metadata
│   │   ├── youtube/      # monitor + scraper + highlights + metadata
│   │   ├── hackernews/   # scraper + processor + metadata（沒有 monitor — 由 RSS 觸發）
│   │   ├── bilibili/     # monitor + scraper + metadata
│   │   ├── xiaohongshu/  # monitor + scraper + metadata
│   │   ├── rss/          # monitor + parser + feed-config
│   │   └── web/          # 共用爬蟲（Readability + Cheerio + OG 擷取）
│   ├── workflows/        # Queue consumer、Workflow class、workflow steps
│   ├── domain/           # AI processor registry、內容清理、實體同步
│   ├── handlers/         # ingest / scrape HTTP handlers
│   ├── monitors/         # 跨平台排程維護
│   └── urls.ts · blob.ts · image-url.ts   # 入庫進入點（URL / blob / 圖片）
├── chat/                 # ── AI chat 介面 ── tools、billing、editor、workspace、sessions
└── media/                # ── 媒體服務 ── 圖片 proxy、簽名 R2 asset、AI 生圖
```

## 環境變數與 Bindings

Bindings（在 `wrangler.jsonc` 裡設定）：

| Binding            | 用途                                        |
| ------------------ | ------------------------------------------- |
| `HYPERDRIVE`       | 連線到你的 Postgres                         |
| `ARTICLE_QUEUE`    | `article-processing-queue-core` 的 producer |
| `MONITOR_WORKFLOW` | `NewsenceMonitorWorkflow` instance 建立     |
| `AI`               | Workers AI（Qwen3 分析 + BGE-M3 向量生成） |
| `BROWSER`          | Cloudflare Browser Rendering（預留）        |

Secrets（透過 `wrangler secret put` 設定）：

| 變數                           | 必要 | 說明                          |
| ------------------------------ | ---- | ----------------------------- |
| `CORE_WORKER_INTERNAL_TOKEN`   | 是   | internal HTTP endpoints token |
| `KAITO_API_KEY`                | 否   | 啟用 Twitter 監控             |
| `YOUTUBE_API_KEY`              | 否   | 啟用 YouTube 頻道監控         |

## 新增平台

平台目前是**鬆散的慣例**而不是正式的 interface — 每個平台資料夾裡會有 `monitor.ts`（定時抓取）、`scraper.ts`（URL 觸發）、`metadata.ts`（型別與 builder）的一些組合，可選 `processor.ts`（自訂 AI 分析）。不是每個平台四件都有；挑一個最接近的平台複製它的形狀。

新增一個來源最少要做：

1. **Scraper**（`ingest/platforms/foo/scraper.ts`）— export 一個回傳 `ScrapedContent` 的函式。
2. **Metadata**（`ingest/platforms/foo/metadata.ts`）— 定義 `FooMetadata` 型別和 `buildFoo(...)` 建構子；在 `shared/platform-metadata.ts` 註冊。
3. **URL 偵測與 dispatch** — 把 URL pattern 加到 `shared/scraped-content.ts:detectPlatformType`，並在 `ingest/platforms/registry.ts` 路由到 scraper。
4. **Monitor**（可選，`ingest/platforms/foo/monitor.ts`）— 如果來源可以輪詢，照現有 cron handler 改一份；在 `entrypoints/scheduled.ts` 裡接上。
5. **Processor**（可選，`ingest/platforms/foo/processor.ts`）— 只有在你需要不同於 `DefaultProcessor` 的 AI 行為時才寫；在 `ingest/domain/processors.ts` 註冊。

新文章一樣走 Queue → Workflow pipeline，AI 步驟你不用動。

## 授權

MIT
