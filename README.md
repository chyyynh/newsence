# Newsence

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/chyyynh/Newsence)
[![Website](https://img.shields.io/badge/Website-newsence.xyz-blue?style=flat-square)](https://app.newsence.xyz)

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
├── monitor/                          # News monitoring workers
│   ├── article-process/              # Article content extraction and processing
│   ├── rss-feed-monitor/             # RSS feed monitoring and parsing
│   ├── twitter-monitor/              # Twitter/X content monitoring
│   ├── websocket-webhook-forwarder/  # WebSocket to webhook bridge
│   └── workflow/                     # Workflow orchestration
│
├── social/                           # Social media integration workers
│   ├── telegram-bot/                 # Telegram bot service
│   ├── telegram-notify/              # Telegram notification service
│   └── twitter-summary/              # Twitter content summarization
│
└── script/                           # Utility scripts
    ├── x_login.js                    # Twitter/X authentication helper
    └── refresh_token.js              # Token refresh utility
```

## Deployment

### Prerequisites

1. [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed

### Setup

1. Copy the example configuration file and fill in your environment variables:

```bash
cp wrangler.json.example wrangler.jsonc
```

2. Edit `wrangler.jsonc` with your Cloudflare account settings and environment variables

### Deploy to Cloudflare

1. Navigate to the worker directory:

```bash
cd monitor/article-process  # or any other worker
```

2. Install dependencies (if needed):

```bash
pnpm install
```

3. Deploy to Cloudflare:

```bash
pnpm wrangler deploy
```

Repeat these steps for each worker you want to deploy.
