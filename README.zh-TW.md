<div align="center">

# newsence

**開源 AI 新聞智慧引擎**

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

[newsence.app](https://www.newsence.app) 自動監控超過 100 個來源（RSS、Twitter、YouTube、Hacker News），將每篇文章翻譯成中英雙語摘要、生成語意向量用於搜尋，並將相關報導自動聚類成主題 —— 全部即時完成。

這個 repo 是核心引擎：一個 Cloudflare Worker 處理完整的內容管線。

## 運作流程

每篇文章經過 7 步驟的自動化 workflow：

```
URL 進入（RSS 排程 / Twitter 排程 / 用戶投稿 / Telegram 機器人）
  │
  ├─ 1. 抓取 ─────────── 平台感知爬蟲，提取內容、metadata、OG 圖片
  ├─ 2. AI 分析 ────────── Gemini 2.5 Flash → 中英標題、摘要、標籤、關鍵字
  ├─ 3. 存入資料庫 ─────── 寫入 Supabase PostgreSQL
  ├─ 4. 生成 Embedding ── BGE-M3 → 1024 維語意向量
  ├─ 5. 儲存向量 ────────── 存入 pgvector 用於相似度搜尋
  ├─ 6. 主題聚類 ────────── 餘弦相似度 > 0.85 → 歸入主題群組
  └─ 7. 主題合成 ────────── 當主題累積 2/3/5/10 篇文章時，AI 生成主題標題
```

每篇約 30 秒完成。每步獨立重試 3 次，指數退避。

## 資料來源

| 來源 | 排程 | 說明 |
|------|------|------|
| **RSS 訂閱** | 每 5 分鐘 | 排程抓取所有 feed，依 URL 去重 |
| **Twitter 列表** | 每 6 小時 | 透過 Kaito API 取得高互動推文 |
| **用戶投稿** | 即時 | `POST /submit` — 完整抓取 + AI 分析，同步回應 |
| **Telegram 機器人** | 即時 | 傳送 URL → 回覆中英雙語摘要 |

## 平台爬蟲

| 平台 | 擷取內容 |
|------|----------|
| **YouTube** | 影片資訊、自動字幕、章節、縮圖 |
| **Twitter/X** | 推文內容、串文重組、互動數據、媒體 |
| **Hacker News** | 原始文章 + HN 討論（Algolia API） |
| **網頁**（預設） | 全文（Cheerio）、OG metadata、作者、日期 |

所有爬蟲輸出統一的 `ScrapedContent` 格式 → 進入同一個 AI 管線。

## AI 管線

| 階段 | 模型 | 輸入 → 輸出 |
|------|------|-------------|
| **翻譯與分析** | Gemini 2.5 Flash | 文章內容 → `title_cn`、`summary`、`summary_cn`、`tags[]`、`keywords[]` |
| **向量生成** | BGE-M3（1024 維） | 標題 + 摘要 + 標籤 → 語意向量 |
| **主題聚類** | 餘弦相似度 | 7 天內相似度 > 0.85 的文章 → 歸入 `topic_id` |
| **主題合成** | Gemini 2.5 Flash | 主題文章群 → 標題 + 描述（中英雙語） |

## 技術棧

| 層級 | 技術 |
|------|------|
| 運行環境 | Cloudflare Workers（V8 isolates） |
| 任務編排 | Cloudflare Queues + Workflows |
| 資料庫 | Supabase PostgreSQL + pgvector |
| 大語言模型 | OpenRouter → Gemini 2.5 Flash |
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
