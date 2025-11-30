# Cloudflare Workers

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/OpenNews/tree/main/cf-worker/core)

> Consolidated Cloudflare Worker for Newsence - RSS monitoring, Twitter tracking, article processing, and AI analysis.

All Cloudflare Workers in one place.

## 📁 Structure

```
cf-worker/
├── .dev.vars              # Shared environment variables (git-ignored)
├── .dev.vars.example      # Environment template
├── article-process/       # Article processing worker
├── rss-feed-monitor/      # RSS feed monitor
├── twitter-monitor/       # Twitter monitor
├── websocket-webhook-forwarder/
├── workflow/
├── telegram-bot/
├── telegram-notify/
└── twitter-summary/
```

## Overview

This worker consolidates 8 separate workers into one core worker, handling:

- **RSS Feed Monitoring** (every 5 minutes)
- **Twitter Monitoring** (every 6 hours)
- **Twitter Summary** (every 5 minutes)
- **Article Daily Processing** (3 AM daily)
- **Workflow Orchestration** using Cloudflare Workflows
- **AI-Powered Article Analysis** using OpenRouter/Gemini
- **WebSocket Message Processing**

## Features

- ✅ Multi-trigger support (HTTP, Cron, Queue, Workflow)
- ✅ Cloudflare Queues for reliable message processing
- ✅ Cloudflare Workflows for orchestration
- ✅ AI-powered article analysis and translation
- ✅ RSS feed parsing with content scraping
- ✅ Twitter high-engagement tweet tracking
- ✅ Structured logging with module prefixes
- ✅ Comprehensive error handling and retry mechanisms

## Architecture

```
RSS Monitor (cron) → articles table → rss-scraping-queue →
Workflow → article-processing-queue → Article Consumer (AI Analysis)

Twitter Monitor (cron) → articles table → twitter-processing-queue →
Workflow → article-processing-queue → Article Consumer (AI Analysis)

WebSocket Client → /webhook → articles table → rss-scraping-queue →
Workflow → article-processing-queue → Article Consumer (AI Analysis)
```

## 🚀 Quick Start

### 1. Setup Environment Variables

All workers share the same environment variables file:

```bash
# Copy the template
cp .dev.vars.example .dev.vars

# Edit with your actual values
vim .dev.vars
```

**Example .dev.vars:**

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key
OPENROUTER_API_KEY=sk-or-v1-your-key
TELEGRAM_BOT_TOKEN=your-token
```

### 2. Local Development

```bash
# Start a single worker
cd article-process
pnpm run dev

# Or start all workers from project root
cd ../..
pnpm run dev
```

### 3. Deploy

#### First-time Setup

Set secrets for staging and production (only need to do this once):

```bash
# From project root
pnpm run sync-secrets:staging
pnpm run sync-secrets:production
```

This will read `cf-worker/.dev.vars` and set all secrets for every worker.

#### Deploy Workers

```bash
# From project root

# Deploy all workers
pnpm run deploy

# Deploy specific worker
pnpm run deploy:article-process
```

## 📝 Environment Variables

### How It Works

Wrangler automatically looks up the directory tree for `.dev.vars`:

```
cf-worker/
├── .dev.vars              ← Wrangler finds this!
└── article-process/
    └── src/index.ts       ← Running `pnpm run dev` here
```

All workers automatically use the shared `.dev.vars` file.

### Local vs Production

- **Local**: Use `.dev.vars` (automatic)
- **Production**: Use Cloudflare Secrets (via `sync-secrets` script)

### When to Update Secrets

You only need to run `sync-secrets` when:

1. **First deployment** - Initial setup
2. **New variable added** - Added to `.dev.vars`
3. **Key rotation** - API key changed
4. **New worker added** - New worker needs secrets

After that, deployments automatically use the saved secrets.

## 🔧 Common Tasks

### Update Environment Variables

```bash
# 1. Edit the shared file
vim cf-worker/.dev.vars

# 2. For local dev: just restart
pnpm run dev

# 3. For production: sync secrets (if needed)
pnpm run sync-secrets:production
```

### Deploy to Staging

```bash
# Auto-deploy on merge to main (via GitHub Actions)
# Or manually:
pnpm run deploy:staging
```

### Deploy to Production

```bash
# Via GitHub Actions (recommended)
# Go to Actions → Deploy to Production → Run workflow

# Or locally:
pnpm run deploy:production
```

### Check Deployed Secrets

```bash
cd article-process
pnpm wrangler secret list --env staging
pnpm wrangler secret list --env production
```

### View Logs

```bash
cd article-process
pnpm wrangler tail --env staging
pnpm wrangler tail --env production
```

## 💡 Tips

### Worker-Specific Variables

If a worker needs different values, create its own `.dev.vars`:

```
cf-worker/
├── .dev.vars                    # Shared (fallback)
└── article-process/
    └── .dev.vars                # Overrides shared values
```

### Use in Code

```typescript
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENROUTER_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env) {
    // Variables automatically available in env
    const url = env.SUPABASE_URL;
    const key = env.OPENROUTER_API_KEY;

    return new Response('OK');
  },
};
```

## 🎯 Deployment Workflow

### Development

```bash
1. Edit cf-worker/.dev.vars
2. cd cf-worker/article-process
3. pnpm run dev
```

### First Deploy

```bash
1. Edit cf-worker/.dev.vars
2. pnpm run sync-secrets:staging      # One-time
3. pnpm run sync-secrets:production   # One-time
4. pnpm run deploy
```

### Daily Deploy

```bash
# Secrets already set, just deploy
pnpm run deploy
```

## 📚 Learn More

- [Wrangler Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Environment Variables](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
