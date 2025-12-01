# Newsence

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/chyyynh/Newsence)
[![Website](https://img.shields.io/badge/Website-newsence.xyz-blue?style=flat-square)](https://app.newsence.xyz)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/newsence/tree/main/cf-worker/core)

**AI-Powered News Intelligence Platform**

Newsence is an news aggregation system that leverages AI to deliver personalized, real-time content across multiple sources.

This open source repo only contain cloudflare workers for monitor news, article processing and social posting. please add wrangler.jsonc file yourself.

![](https://www.mermaidchart.com/raw/ce8745bd-e9c3-4711-9dbe-636f96e9e14d?theme=light&version=v0.1&format=svg)

## Core Feature

- **Resource Processing**: Monitoring and content extraction
- **Collecting**: save any resources in one place and use ai to understand better
- **AI Remix**: remix your feed to daily newsletter, social post and even research

## Technical Stack

- **Frontend(not opensource)**: Next.js, Zustand, Motion
- **Backend**: Cloudflare Workers
- **Database**: PostgreSQL with Supabase, Prisma
- **Tool**: Statsig, polar.sh for payment

## Project Structure

This repository contains the open-source Cloudflare Workers components:

```
.
├── cf-worker/                        # All Cloudflare Workers
│   ├── core/                         # Combining rss, twitter & process worker, queues and workflow
│   ├── article-process/              # Article content extraction and processing
│   ├── rss-feed-monitor/             # RSS feed monitoring and parsing
│   ├── twitter-monitor/              # Twitter/X content monitoring
│   ├── websocket-webhook-forwarder/  # WebSocket to webhook bridge
│   ├── workflow/                     # Workflow orchestration
│   ├── telegram-bot/                 # Telegram bot service
│   ├── telegram-notify/              # Telegram notification service
│   └── twitter-summary/              # Twitter content summarization
│
└── script/                           # Utility scripts
    ├── x_login.js                    # Twitter/X authentication helper
    └── refresh_token.js              # Token refresh utility
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed

### Installation

```bash
# Install dependencies
pnpm install

# Setup environment variables
cd cf-worker
cp .dev.vars.example .dev.vars
vim .dev.vars  # Edit with your actual values
```

### Local Development

```bash
# Start all workers
pnpm run dev

# Or start individual worker
cd cf-worker/article-process
pnpm run dev
```

### Deployment

#### Quick Deploy (All Workers)

```bash
# Deploy all workers
pnpm run deploy

# Deploy individual worker
pnpm run deploy:article-process
```

#### Individual Worker Deploy

```bash
# Navigate to worker directory
cd cf-worker/article-process

# Deploy
pnpm wrangler deploy
```

#### Automated CI/CD

We support automated deployment via GitHub Actions:

- **Staging**: Auto-deploy on merge to `main`
- **Production**: Manual trigger or Git tag

See [CICD-SETUP.md](./CICD-SETUP.md) for 10-minute setup guide.

## Documentation

### Getting Started

- [QUICK-START.md](./QUICK-START.md) - 5-minute quick start ⭐ Start here!
- [FLAT-STRUCTURE.md](./FLAT-STRUCTURE.md) - New flat structure explanation

### Workers Management

- [WORKERS.md](./WORKERS.md) - Complete workers guide
- [WORKERS-QUICK-REF.md](./WORKERS-QUICK-REF.md) - Quick reference

### CI/CD

- [CICD.md](./CICD.md) - Full CI/CD documentation
- [CICD-SETUP.md](./CICD-SETUP.md) - Quick setup (10 min)
- [CICD-QUICK-REF.md](./CICD-QUICK-REF.md) - Command reference

### Environment Variables

- [ENV-SETUP.md](./ENV-SETUP.md) - Environment variable management

## Architecture

### Workers Flow

```
RSS Monitor (Cron) → Queue → Article Processor
                              ↓
                         Supabase DB
                              ↓
                     Telegram/Twitter Bot
```

For detailed architecture, see documentation above.
