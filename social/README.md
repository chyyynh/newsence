# Social Connect Workers

OpenNews 社交媒體連接系統，包含 Telegram 和 Twitter 自動化 Workers。

## 架構概覽

```
social-connect/
├── telegram-worker/          # Telegram 新聞摘要推送 (每3小時)
├── telegram-bot-worker/      # Telegram 互動機器人
├── twitter-summary-worker/   # Twitter 自動發文 (每4小時)
├── deploy-all.sh            # 一鍵部署腳本
└── README.md               # 本文件
```

## Workers 說明

### 1. 📱 Telegram Worker
- **功能**: 每3小時生成並推送新聞摘要到 Telegram
- **排程**: `0 */3 * * *` (每3小時執行)
- **範圍**: 90-180分鐘前的文章
- **AI引擎**: OpenRouter API
- **推送對象**: 註冊用戶 + 頻道

### 2. 🤖 Telegram Bot Worker
- **功能**: 處理 Telegram 用戶互動和登入
- **觸發**: Telegram Webhook
- **主要功能**: 
  - 用戶註冊/登入
  - 偏好設定
  - 即時查詢

### 3. 🐦 Twitter Summary Worker
- **功能**: 每4小時選擇最重要新聞發布到 Twitter
- **排程**: `0 */4 * * *` (每4小時執行)
- **範圍**: 過去4小時內的文章
- **特色**: 
  - 智能重要性評分
  - 精確字數控制 (letter-count)
  - 自動重試機制
  - 重複發布防護

## 部署方式

### 🚀 一鍵部署 (推薦)

```bash
cd social-connect
./deploy-all.sh
```

### 📝 手動部署

```bash
# 部署 Telegram Worker
cd telegram-worker
pnpm install && pnpm run deploy

# 部署 Telegram Bot Worker  
cd ../telegram-bot-worker
pnpm install && pnpm run deploy

# 部署 Twitter Summary Worker
cd ../twitter-summary-worker
pnpm install && pnpm run deploy
```

## 環境變數配置

每個 Worker 都需要在 Cloudflare Workers 中設定對應的環境變數。

### Telegram Worker
```
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<your-supabase-key>
TELEGRAM_BOT_TOKEN=<your-telegram-bot-token>
TELEGRAM_CHANNEL_ID=<your-telegram-channel-id>
OPENROUTER_API_KEY=<your-openrouter-api-key>
GEMINI_API_KEY=<your-gemini-api-key>
```

### Telegram Bot Worker
```
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<your-supabase-key>
TELEGRAM_BOT_TOKEN=<your-telegram-bot-token>
```

### Twitter Summary Worker
```
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<your-supabase-key>
OPENROUTER_API_KEY=<your-openrouter-api-key>
TWITTER_CLIENT_ID=<your-twitter-client-id>
TWITTER_CLIENT_SECRET=<your-twitter-client-secret>
TWITTER_KV=<your-kv-namespace>
```

## 資料庫設定

### Twitter Summary Worker 需要額外的資料表

```sql
-- 執行 twitter-summary-worker/twitter_posts_table.sql
CREATE TABLE twitter_posts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    article_id TEXT NOT NULL,
    tweet_ids TEXT[] NOT NULL,
    tweet_content TEXT NOT NULL,
    article_score DECIMAL NOT NULL,
    posted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## 監控和除錯

### 查看部署狀態
```bash
wrangler deployments list
```

### 即時日誌監控
```bash
# Telegram Worker
wrangler tail telegram-worker

# Telegram Bot Worker  
wrangler tail telegram-bot-worker

# Twitter Summary Worker
wrangler tail twitter-summary-worker
```

### 手動觸發測試
```bash
# 測試 Telegram Worker
wrangler dev --test-scheduled

# 測試 Twitter Summary Worker
wrangler dev --test-scheduled
```

## 系統特色

- ✅ **完全分離**: 三個 Worker 獨立運作，互不干擾
- ✅ **智能排程**: 不同頻率避免資源衝突
- ✅ **精確控制**: Twitter 字數控制和重試機制
- ✅ **高可靠性**: 完整錯誤處理和日誌記錄
- ✅ **易於維護**: 清晰的模組化架構
- ✅ **一鍵部署**: 自動化部署流程

## 故障排除

### 常見問題

1. **部署失敗**: 檢查 wrangler 登入狀態和專案權限
2. **環境變數錯誤**: 確認所有必要變數都已設定
3. **資料庫連接問題**: 檢查 Supabase URL 和 key 是否正確
4. **Twitter API 錯誤**: 確認 OAuth token 是否有效

### 查看詳細日誌
所有 Worker 都有詳細的日誌輸出，可透過 `wrangler tail` 命令即時查看執行狀況。