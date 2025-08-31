# Newsence

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/chyyynh/Newsence)

[Website Demo](https://open-news-psi.vercel.app/) | [Telegram Channel](https://t.me/opennews_demo) | [Twitter Demo](https://x.com/artofcryptowar)

An AI-powered news aggregation system that helps users stay informed about topics they care about — from cryptocurrency markets to emerging tech sectors.

**Key Features:**

- Smart RSS feed monitoring with AI-powered content analysis
- Automated social media posting with intelligent scheduling
- Real-time processing with Cloudflare Workers

![](https://www.mermaidchart.com/raw/ce8745bd-e9c3-4711-9dbe-636f96e9e14d?theme=light&version=v0.1&format=svg)

## Core Components

### 🖥️ Core Services

- **RSS Feed Processing**: Automated monitoring and content extraction
- **AI Content Analysis**: Smart summarization and topic classification
- **Multi-Platform Distribution**: Telegram and Twitter integration
- **Real-time Updates**: WebSocket-based live content delivery

### ⚙️ Backend Infrastructure

- **RSS Monitor**: Automated feed scanning every 5 minutes via Cloudflare Workers
- **AI Summarization**: Intelligent content processing and summary generation
- **Social Integration**: Auto-posting to Twitter/Telegram with OAuth2 authentication
- **Real-time Processing**: WebSocket support for live updates

### 🔧 Technical Stack

- **Frontend**: Next.js, React, TypeScript, Zustand
- **Backend**: Cloudflare (Workers, Queue, Workflow), Prisma ORM
- **Database**: PostgreSQL with Supabase
- **Deployment**: Vercel (Frontend), Cloudflare (Workers)
