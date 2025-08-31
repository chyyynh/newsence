#!/bin/bash

# Twitter Summary Worker 部署腳本

echo "📦 安裝依賴..."
pnpm install

echo "🔧 構建 TypeScript..."
pnpm run cf-typegen

echo "🚀 部署到 Cloudflare Workers..."
pnpm run deploy

echo "✅ Twitter Summary Worker 部署完成！"
echo ""
echo "⏰ 排程: 每4小時執行一次 (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)"
echo "🎯 功能: 自動選擇最重要的新聞並發布到 Twitter"
echo ""
echo "📊 檢查部署狀態:"
echo "https://dash.cloudflare.com/workers"