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

[**newsence.app**](https://www.newsence.app) 的引擎。支援 RSS、Twitter/X、YouTube、Hacker News、一般網頁與用戶檔案，自動中英雙語 AI 分析、Embedding 還有知識圖譜。遵循 [**LLM Wiki**](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 模式 — 每個來源讀一次就整合進一個持續成品（摘要、實體、embeddings、交叉引用），不是 query time 才做 RAG。

## 支援平台

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)

| 平台            | 類型   | 排程       | 說明                                             |
| --------------- | ------ | ---------- | ------------------------------------------------ |
| **RSS 訂閱**    | 監控   | 每 5 分鐘  | 抓取 feed、依 URL 去重、偵測 HN 連結             |
| **Twitter/X**   | 監控   | 每 6 小時  | 透過 Kaito API 追蹤用戶 — 推文、串文、長文、媒體 |
| **YouTube**     | 監控   | 每 30 分鐘 | Atom feed → 影片資訊、字幕、章節、AI 精華段落    |
| **Hacker News** | 處理器 | 經由 RSS   | 偵測 HN 連結 → Algolia 取評論 → 生成編輯筆記     |
| **網頁**        | 爬蟲   | saved URL  | 全文擷取（Readability + Cheerio）、OG metadata   |
| **用戶檔案**    | 入口   | 即時       | App service-binding RPC — saved URL scrape + enrichment；blob 生命週期由 app 擁有 |

所有平台輸出統一的 `NormalizedContent` 格式 → 進入同一個 AI 管線。

## 運作流程

每篇文章經過自動化 workflow，各步驟獨立重試：

```
內容進入（source monitor / saved URL / retry）
  │
  ├─ 1. 讀取內容 ─────────── source draft 從 R2 載入；upload/retry 則讀既有 row
  ├─ 2. AI 分析 ──────────── AI Gateway text/JSON calls → 中英標題、摘要、標籤、關鍵字、實體
  ├─ 3. 存入資料庫 ────────── source 單次 final INSERT；row-based 單次 final UPDATE
  ├─    同步實體 ─────────── （條件性）將實體寫入正規化表格，建立關聯
  ├─ 4. YouTube 精華 ─────── （僅 YouTube）從字幕生成 AI 精華段落
  └─ 5. 生成 Embedding ──── BGE-M3 → 1024 維向量（標題 + 摘要 + 全文 + 實體名稱）
```

每篇約 30 秒完成。每步獨立重試，指數退避。

## AI 管線

| 階段         | 模型              | 說明                                                        |
| ------------ | ----------------- | ----------------------------------------------------------- |
| **分析**     | AI Gateway text model | 文章 → 中英標題、摘要、標籤、關鍵字、分類                   |
| **實體提取** | AI Gateway JSON model | 文章 → 具名實體（人物、組織、產品、技術、事件），含中英名稱 |
| **向量生成** | BGE-M3（1024 維）     | 標題 + 摘要 + 全文 + 實體名稱 → 語意向量（HNSW 索引）       |

翻譯/摘要與分類/實體是分開的 structured calls，避免其中一個 schema 失敗就讓整篇文章落入 fallback。

## 技術棧

| 層級         | 技術                                                |
| ------------ | --------------------------------------------------- |
| 運行環境     | Cloudflare Workers（V8 isolates）                   |
| 任務編排     | Cloudflare Workflows                                |
| 資料庫       | PostgreSQL + pgvector（透過 Cloudflare Hyperdrive） |
| 大語言模型   | Cloudflare AI Gateway                               |
| 向量生成     | Cloudflare Workers AI → BGE-M3                      |
| Twitter 數據 | Kaito API（第三方）                                 |

## 自行部署

上方的一鍵 Deploy 按鈕會幫你建好 Worker + Workflows，**但 Hyperdrive、資料庫、secrets 需要手動設定**。完整步驟：

### 1. 資料庫

需要一個裝了 pgvector 的 PostgreSQL。目前跑在 PlanetScale Postgres（透過 Cloudflare Hyperdrive）；任何 Postgres ≥ 15 + `vector` extension 都行。

需要的表：`articles`、`user_articles`、`RssList`、`youtube_transcripts`，以及 entity / citation 相關表格。完整 schema 定義在上層 monorepo 的 `web-tanstack/prisma/schema.prisma` — 獨立的 `schema.sql` 還在 roadmap。目前可以參考 Prisma models，或在 Issues 聯絡我。

### 2. Hyperdrive binding

建一個 Hyperdrive 指向你的資料庫：

```bash
wrangler hyperdrive create newsence-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

把回傳的 ID 填進 `wrangler.jsonc` 的 `hyperdrive[].id` 欄位。

### 3. Cloudflare Workflows

Workflows 會在第一次 deploy 時透過 `wrangler.jsonc` 裡的 `workflows` bindings 自動建立。

### 4. Secrets

AI 分析與向量生成都走 Workers AI binding，不需要外部 LLM secret。平台/API secrets 由 Wrangler config 設為必填：

```bash
wrangler secret put KAITO_API_KEY            # Twitter 監控
wrangler secret put YOUTUBE_API_KEY          # YouTube 監控
wrangler secret put S2_API_KEY               # Semantic Scholar quota
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

驗證：internal endpoints 需要 `X-Internal-Token` 或 `Authorization: Bearer`。用戶 ingest 限流現在由 app Worker 在呼叫 core Worker 前處理。

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
├── entrypoints/          # HTTP router、protected endpoints、health
├── rpc/                  # service-binding RPC contract
├── ai/                   # Workers AI / AI Gateway helpers
├── entities/             # entity normalization + graph sync
├── media/                # OG image helpers
├── shared/               # 小型跨子系統 primitives
│   ├── platform-metadata.ts
│   ├── types.ts          # Article、NormalizedContent、YoutubeTranscript
│   └── web.ts            # fetch、URL normalization、stream limits
├── ingest/               # ── 文章入庫 pipeline（開源核心）──
│   ├── workflow.ts       # Workflow class + enqueueProcessing
│   ├── urls.ts           # saved URL 偵測、fetch、orchestration；asset result 由 app 持久化
│   ├── domain/           # sink、AI merge helpers
│   ├── platforms/        # 每個平台一個資料夾
│   │   ├── rss/          # feed polling
│   │   ├── twitter/      # monitor + scraper + processor
│   │   ├── youtube/      # monitor + scraper + transcript/highlights
│   │   ├── hackernews/   # scraper + processor（由 RSS 或 URL 觸發）
│   │   ├── paper/        # Semantic Scholar enrichment
│   │   ├── pdf.ts        # PDF text extraction stage
│   │   └── web-scraper.ts
└── corpus.ts · okf.ts     # engine 讀取、搜尋、匯出輔助
```

## 環境變數與 Bindings

Bindings（在 `wrangler.jsonc` 裡設定）：

| Binding            | 用途                                        |
| ------------------ | ------------------------------------------- |
| `HYPERDRIVE`       | 連線到你的 Postgres                         |
| `MONITOR_WORKFLOW` | `NewsenceMonitorWorkflow` instance 建立     |
| `R2`               | Source drafts、PDF text temp objects、app-owned blob reads |
| `AI`               | Workers AI binding（AI Gateway 文字呼叫 + BGE-M3 向量生成） |

Secrets（透過 `wrangler secret put` 設定）：

| 變數                           | 必要 | 說明                          |
| ------------------------------ | ---- | ----------------------------- |
| `KAITO_API_KEY`                | 是   | 啟用 Twitter 監控             |
| `YOUTUBE_API_KEY`              | 是   | 啟用 YouTube 頻道監控         |
| `S2_API_KEY`                   | 是   | 提高 Semantic Scholar paper enrichment quota |

## 新增平台

平台是來源 adapter。每個平台資料夾裡會有 `monitor.ts`（定時 discovery）、`scraper.ts`（URL 觸發）、metadata builder 的一些組合，可選 `processor.ts`（自訂 AI 分析）。不是每個平台四件都有；挑一個最接近的平台複製它的形狀。

三個軸要分開：platform（`rss`、`web`、`youtube`、`twitter`、`hackernews`）不是 content shape（`pdf`、academic paper），也不是 origin（`upload`、`saved_url`、`generated`）。PDF 解析和 Semantic Scholar paper enrichment 是 workflow stage，根據 row 內容或 metadata 觸發，不是 platform adapter。

新增一個來源最少要做：

1. **Scraper**（`ingest/platforms/foo/scraper.ts`）— export 一個回傳 `NormalizedContent` 的函式。
2. **Metadata**（`ingest/platforms/foo/metadata.ts`）— 定義 `FooMetadata` 型別和 `buildFoo(...)` 建構子；在 `shared/platform-metadata.ts` 註冊。
3. **URL 偵測與 dispatch** — 把 URL pattern 加到 `shared/web.ts:detectUrlKind`，並從 `ingest/urls.ts` 路由到 scraper。
4. **Monitor**（可選，`ingest/platforms/foo/monitor.ts`）— 如果來源可以輪詢，照現有 cron handler 改一份；在 `src/index.ts` 裡接上。
5. **Processor**（可選，`ingest/platforms/foo/processor.ts`）— 只有在你需要不同於預設 workflow processor 的 AI 行為時才寫；從 `ingest/workflow.ts` 註冊。

新文章一樣走 Workflow pipeline，AI 步驟你不用動。

## 授權

MIT
