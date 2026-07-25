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

[**newsence.app**](https://www.newsence.app) 的引擎。支援 RSS、Twitter/X、YouTube、Hacker News、一般網頁與上傳檔案，自動中英雙語 AI 分析與知識圖譜，並將完成 enrichment 的 corpus resource 同步到 Cloudflare AI Search。

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
| **App 輸入**    | 入口   | 即時       | Service-binding RPC — saved URL/blob acquisition + enrichment；membership 由 app 擁有 |

所有平台輸出統一的 `NormalizedContent` 格式 → 進入同一個 AI 管線。

## 運作流程

每個 resource 經過自動化 workflow，各步驟獨立重試：

```
內容進入（source monitor / saved URL / uploaded blob / resync）
  │
  ├─ 1. 讀取 Resource ───── canonical resources row；抓取 URL 內容或抽取上傳 PDF 文字
  ├─ 2. AI 分析 ──────────── AI Gateway text/JSON calls → 中英標題、摘要、標籤、關鍵字、實體
  ├─ 3. 存入資料庫 ────────── 更新 resources + resource_translations
  ├─    同步實體 ─────────── 將實體寫入正規化表格，透過 resource_entities 建立關聯
  ├─ 4. YouTube 精華 ─────── （僅 YouTube）從字幕生成 AI 精華段落
  └─ 5. 同步 AI Search ───── 將完成 enrichment 的 corpus 文件上傳到 Cloudflare AI Search
```

每個 resource 約 30 秒完成。每步獨立重試，指數退避。

## AI 管線

| 階段         | 模型              | 說明                                                        |
| ------------ | ----------------- | ----------------------------------------------------------- |
| **分析**     | AI Gateway text model | Resource → 中英標題、摘要、標籤、關鍵字、分類               |
| **實體提取** | AI Gateway JSON model | Resource → 具名實體（人物、組織、產品、技術、事件），含中英名稱 |
| **搜尋索引** | Cloudflare AI Search  | 對完成 enrichment 的 corpus 文件提供 hybrid retrieval       |

翻譯/摘要與分類/實體是分開的 structured calls，避免其中一個 schema 失敗就讓整個 resource 落入 fallback。

## 技術棧

| 層級         | 技術                                                |
| ------------ | --------------------------------------------------- |
| 運行環境     | Cloudflare Workers（V8 isolates）                   |
| 任務編排     | Cloudflare Workflows                                |
| 資料庫       | PostgreSQL（透過 Cloudflare Hyperdrive）            |
| 大語言模型   | Cloudflare AI Gateway                               |
| 搜尋         | Cloudflare AI Search                                |
| Twitter 數據 | Kaito API（第三方）                                 |

## 自行部署

上方的一鍵 Deploy 按鈕會幫你建好 Worker + Workflows，**但 Hyperdrive、資料庫、secrets 需要手動設定**。完整步驟：

### 1. 資料庫

需要一個 PostgreSQL。正式環境目前透過 Cloudflare Hyperdrive 連到 PlanetScale Postgres。

Core 使用的 app-owned tables 會同步定義在 `src/db/schema.ts`；canonical schema 位於 `web-tanstack/prisma/schema.prisma`，DB-only constraints 與 indexes 則位於 `web-tanstack/prisma/manual-indexes.sql`。任一 schema 變更後請執行 `pnpm check:db-schema`。

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

AI 分析透過 Workers AI binding 與 AI Gateway 執行，不需要外部 LLM secret。平台/API secrets 由 Wrangler config 設為必填：

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

## API Surface

HTTP surface 只提供 `GET /health`。App/chat 透過 Cloudflare service-binding RPC 傳入已持久化的 resource ID，cron monitor 使用 scheduled triggers；URL acquisition 只存在於 canonical resource workflow 內部。

## Hosted MCP

newsence app 在 `https://www.newsence.app/api/mcp` 提供 hosted
[MCP](https://modelcontextprotocol.io) endpoint。已退役的本機 CLI／MCP
套件不屬於這個 Worker。

## 架構

```
src/
├── index.ts              # 只保留 Cloudflare WorkerEntrypoint class
├── ai/                   # Workers AI / AI Gateway helpers
├── entities/             # entity normalization + graph sync
├── shared/               # 小型跨子系統 primitives
│   ├── types.ts          # ResourceForProcessing、NormalizedContent、YoutubeTranscript
│   └── web.ts            # fetch、URL normalization、stream limits
├── ingest/               # ── resource 入庫 pipeline（開源核心）──
│   ├── workflow.ts       # Workflow class + enqueueProcessing
│   ├── domain/           # sink、AI merge helpers
│   └── platforms/        # 每個來源或 stage 一個檔案
│       ├── rss.ts        # feed polling
│       ├── twitter.ts    # monitor + scraper + processor
│       ├── youtube.ts    # monitor + transcript/highlights
│       ├── hackernews.ts # HN processor
│       ├── paper.ts      # Semantic Scholar enrichment stage
│       └── pdf.ts        # PDF text extraction stage
└── corpus.ts · okf.ts     # engine 讀取、搜尋、匯出輔助
```

## 環境變數與 Bindings

Bindings（在 `wrangler.jsonc` 裡設定）：

| Binding            | 用途                                        |
| ------------------ | ------------------------------------------- |
| `HYPERDRIVE`       | 連線到你的 Postgres                         |
| `RESOURCE_PROCESSING_WORKFLOW` | 抓取、解析、分類並寫回 resource |
| `RESOURCE_TRANSLATION_WORKFLOW` | 將已持久化的 resource 翻譯成繁體中文 |
| `SEARCH_INDEX_REBUILD_WORKFLOW` | 從 Postgres 全量重建搜尋索引 |
| `R2`               | 讀取 app-owned uploaded blob，供 PDF extraction 使用 |
| `AI`               | Workers AI binding（AI Gateway 文字呼叫）   |
| `AI_SEARCH`        | Cloudflare AI Search corpus namespace       |

Secrets（透過 `wrangler secret put` 設定）：

| 變數                           | 必要 | 說明                          |
| ------------------------------ | ---- | ----------------------------- |
| `KAITO_API_KEY`                | 是   | 啟用 Twitter 監控             |
| `YOUTUBE_API_KEY`              | 是   | 啟用 YouTube 頻道監控         |
| `S2_API_KEY`                   | 是   | 提高 Semantic Scholar paper enrichment quota |

## 新增平台

平台是來源 adapter。每個平台集中在一個 `ingest/platforms/*.ts` 檔案裡，只放它真正需要的 discovery / scrape / process 邏輯。App-owned saved URL 和 upload 由 app 先寫成 `resources`/`library` rows；workflow 收到的是 `resourceId`。SQL 寫入留在 `ingest/domain/resource-store.ts`。

三個軸要分開：platform（`rss`、`web`、`youtube`、`twitter`、`hackernews`）不是 content shape（`pdf`、academic paper），也不是 origin（`upload`、`saved_url`、`generated`）。PDF 解析和 Semantic Scholar paper enrichment 是 workflow stage，根據 row 內容或 metadata 觸發，不是 platform adapter。

新增一個來源最少要做：

1. **Platform file**（`ingest/platforms/foo.ts`）— discovery / scrape helpers 和可選自訂 processor。
2. **Metadata shape** — 只加入 `platform_metadata` 真的需要的平台 JSON payload。
3. **Monitor**（可選）— 如果來源可以輪詢，從 `src/index.ts` 接上 cron handler。
4. **Workflow hook**（可選）— 只有在來源需要不同於預設 AI merge 的行為時才加。

新 resource 一樣走 Workflow pipeline，AI 步驟你不用動。

## 授權

MIT
