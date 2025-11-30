# Twitter Summary Worker

自動 Twitter 新聞總結發布系統，每4小時選擇最重要的新聞發布到 Twitter。

## 功能特點

- ⏰ **每4小時執行** (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
- 🎯 **智能選擇** 基於多維度評分選擇最重要的新聞
- 📝 **精確字數控制** 使用 `letter-count` 確保符合 Twitter 字數限制
- 🔄 **自動重試** 如字數超過限制會自動重新生成
- 🚫 **避免重複** 追蹤已發布文章避免重複發布

## 評分算法

文章重要性評分基於以下因素：

### 1. 關鍵字匹配 (最高 +5 分)
- AI、ChatGPT、OpenAI、Google、Meta 等科技關鍵字
- breakthrough、funding、IPO、regulation 等重要事件
- 標題中的關鍵字權重更高

### 2. 標籤重要性 (+3 分)
- AI、Regulation、Security、Funding 等重要標籤

### 3. 來源權威性 (+4 分)
- OpenAI、Google Deepmind、Anthropic、CNBC、Techcrunch 等權威來源

### 4. 時效性 (最高 +5 分)
- 2小時內: +5 分
- 6小時內: +4 分  
- 12小時內: +3 分
- 24小時內: +2 分
- 48小時內: +1 分

## 字數控制

- 總推文限制：**240 字符** (為URL預留空間)
- 使用 `letter-count` 精確計算中英文混合字符數
- Twitter URL 自動縮短為 23 字符
- 最多重試 3 次生成符合長度的內容
- 漸進式提示調整提高成功率

## 部署

1. 安裝依賴：
```bash
pnpm install
```

2. 在 Supabase 執行 SQL 創建追蹤表：
```sql
-- 執行 twitter_posts_table.sql
```

3. 設定環境變數在 `wrangler.jsonc`

4. 部署到 Cloudflare Workers：
```bash
pnpm run deploy
```

## 監控

可以通過 Cloudflare Workers 日誌查看：
- 文章選擇過程和評分
- OpenRouter API 調用和重試
- 字數檢查結果
- Twitter 發布狀態

## 測試

```bash
# 測試字數計算功能
npx tsx src/test-letter-count.ts
```

## 環境變數

- `SUPABASE_URL`: Supabase 項目 URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase 服務角色密鑰
- `OPENROUTER_API_KEY`: OpenRouter API 密鑰
- `TWITTER_CLIENT_ID`: Twitter API 客戶端 ID  
- `TWITTER_CLIENT_SECRET`: Twitter API 客戶端密鑰
- `TWITTER_KV`: Cloudflare KV 存儲 (用於 Twitter token)