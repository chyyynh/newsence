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

newsence 是一個內容發現系統。它持續監控網路上的各種來源，從每篇文章中提取結構化知識，並讓這些知識可被搜尋、分析和 AI 工作流使用。

你可以把它想成一個永不休息的研究助手 — 閱讀所有內容、提取其中提到的人物、組織、技術和事件，然後把一切整理成可搜尋的知識庫。

**核心循環：**
```
來源進入（RSS、Twitter、YouTube、HN、Bilibili、小紅書、手動提交）
  → AI 閱讀並分析每篇文章
  → 提取實體（人物、組織、產品、技術、事件）
  → 生成中英雙語摘要
  → 建立語意向量用於搜尋
  → 透過共享實體連結文章
```

這個 repo 是核心引擎：一個 Cloudflare Worker 處理完整的內容管線。

## 支援平台

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)
![Bilibili](https://img.shields.io/badge/Bilibili-00A1D6?logo=bilibili&logoColor=white)
![Xiaohongshu](https://img.shields.io/badge/Xiaohongshu-FF2442?logo=xiaohongshu&logoColor=white)

| 平台 | 類型 | 排程 | 說明 |
|------|------|------|------|
| **RSS 訂閱** | 監控 | 每 5 分鐘 | 抓取 feed、依 URL 去重、偵測 HN 連結 |
| **Twitter/X** | 監控 | 每 6 小時 | 透過 Kaito API 追蹤用戶 — 推文、串文、長文、媒體 |
| **YouTube** | 監控 | 每 30 分鐘 | Atom feed → 影片資訊、字幕、章節、AI 精華段落 |
| **Bilibili** | 監控 | 每 30 分鐘 | gRPC 移動端 API → 用戶動態、影片卡片 |
| **小紅書** | 監控 | 每 30 分鐘 | 用戶主頁抓取 → 筆記、封面 |
| **Hacker News** | 處理器 | 經由 RSS | 偵測 HN 連結 → Algolia 取評論 → 生成編輯筆記 |
| **網頁** | 爬蟲 | 按需 | 全文擷取（Readability + Cheerio）、OG metadata |
| **用戶投稿** | 入口 | 即時 | `POST /submit` — 完整抓取 + AI 分析，同步回應 |
| **Telegram 機器人** | 入口 | 即時 | 傳送 URL → 回覆中英雙語摘要 |

所有平台輸出統一的 `ScrapedContent` 格式 → 進入同一個 AI 管線。

## 運作流程

每篇文章經過自動化 workflow，各步驟獨立重試：

```
URL 進入（RSS 排程 / Twitter 排程 / 用戶投稿 / Telegram 機器人）
  │
  ├─  1. 讀取文章 ────────── 從資料庫載入文章
  ├─  2. AI 分析 ─────────── Gemini Flash → 中英標題、摘要、標籤、關鍵字、實體
  ├─  3. 抓取 OG 圖片 ────── 若缺少圖片則輕量抓取（僅前 32KB）
  ├─  4. 翻譯全文 ─────────── 全文 → 繁體中文
  ├─  5. 存入資料庫 ────────── 單次 UPDATE 寫入所有 AI 結果
  ├─ 5b. 同步實體 ─────────── 將實體寫入正規化表格，建立文章-實體關聯
  ├─  6. 通知 Telegram ────── 推送結果至 Telegram 機器人（若經由 bot 觸發）
  ├─  7. YouTube 精華 ─────── 從字幕生成 AI 精華段落（僅 YouTube）
  └─  8. 生成 Embedding ──── BGE-M3 → 1024 維向量（標題 + 摘要 + 全文 + 實體名稱）
```

每篇約 30 秒完成。每步獨立重試，指數退避。

## AI 管線

| 階段 | 模型 | 說明 |
|------|------|------|
| **分析** | Gemini Flash Lite | 文章 → 中英標題、摘要、標籤、關鍵字、分類 |
| **實體提取** | Gemini Flash Lite | 文章 → 具名實體（人物、組織、產品、技術、事件），含中英名稱 |
| **全文翻譯** | Gemini Flash | 全文內容 → 繁體中文 |
| **向量生成** | BGE-M3（1024 維） | 標題 + 摘要 + 全文 + 實體名稱 → 語意向量（HNSW 索引） |

實體提取與分析在同一次 LLM 呼叫中完成 — 零額外 API 成本。

## 技術棧

| 層級 | 技術 |
|------|------|
| 運行環境 | Cloudflare Workers（V8 isolates） |
| 任務編排 | Cloudflare Queues + Workflows |
| 資料庫 | Supabase PostgreSQL + pgvector |
| 大語言模型 | OpenRouter → Gemini Flash / Flash Lite |
| 向量生成 | Cloudflare Workers AI → BGE-M3 |
| Twitter 數據 | Kaito API |

## 快速開始

```bash
pnpm install
cp wrangler.jsonc.example wrangler.jsonc   # 填入你的 API keys
pnpm dev                                    # 本地開發
pnpm run deploy                             # 部署到 Cloudflare
```

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
  "results": [{
    "articleId": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Article Title",
    "sourceType": "web",
    "alreadyExists": false
  }]
}
```

</details>

可選驗證：`X-Internal-Token` header。內建限流：每 key 20 次/60 秒（可設定）。

## CLI 與 MCP 伺服器

也可以透過 [`newsence`](https://www.npmjs.com/package/newsence) npm 套件使用：

```bash
npx newsence search "AI agents"       # 搜尋文章
npx newsence recent --hours 6         # 最近幾小時的文章

claude mcp add newsence -- npx newsence mcp   # 加入 Claude Code
# 遠端 MCP：https://www.newsence.app/api/mcp
```

## 架構

```
src/
├── index.ts                  # 入口 — 路由 HTTP、Cron、Queue
├── platforms/                # 各平台獨立實作
│   ├── twitter/              # monitor, scraper, processor, metadata
│   ├── youtube/              # monitor, scraper, highlights, metadata
│   ├── hackernews/           # scraper, processor, metadata
│   ├── rss/                  # monitor, parser, feed-config
│   └── web/                  # scraper（共用網頁 + OG 擷取）
├── domain/
│   ├── workflow.ts           # Workflow 編排
│   ├── processors.ts         # AI 處理器工廠 + DefaultProcessor
│   ├── ai-utils.ts           # 共用 AI 函式（Gemini、翻譯）
│   ├── entities.ts           # 實體同步至正規化表格
│   └── distribute.ts         # 非預設來源的訂閱分發
├── infra/                    # OpenRouter、Workers AI、DB、HTTP 工具
├── models/                   # 型別、平台 metadata 聯合型別
└── app/handlers/             # HTTP 路由處理器
```

## 環境變數

| 變數 | 必要 | 說明 |
|------|------|------|
| `SUPABASE_URL` | 是 | Supabase 專案 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | Supabase service role key |
| `OPENROUTER_API_KEY` | 是 | OpenRouter API key |
| `CORE_WORKER_INTERNAL_TOKEN` | 否 | `/submit` 驗證 token |
| `YOUTUBE_API_KEY` | 否 | YouTube Data API |
| `KAITO_API_KEY` | 否 | Kaito API（Twitter） |
| `TRANSCRIPT_API_KEY` | 否 | YouTube 字幕 API |

## 授權

MIT
