# Newsence

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/chyyynh/Newsence)

[Website Demo](https://open-news-psi.vercel.app/) | [Telegram Channel](https://t.me/opennews_demo) | [Twitter Demo](https://x.com/artofcryptowar)

An AI-powered news aggregation system that helps users stay informed about topics they care about — from cryptocurrency markets to emerging tech sectors.

**Key Features:**

- 🔍 Smart RSS feed monitoring with AI-powered content analysis
- 🤖 Automated social media posting with intelligent scheduling
- 📱 Multi-platform support (Web, Telegram Bot, Twitter)
- ⚡ Real-time processing with Cloudflare Workers
- 🎯 Personalized news filtering and recommendations

![](https://www.mermaidchart.com/raw/ce8745bd-e9c3-4711-9dbe-636f96e9e14d?theme=light&version=v0.1&format=svg)

## Core Components

### 🖥️ Frontend Platform

- **Multi-Platform Access**: Web dashboard, Telegram bot, and Mini App support
- **Authentication**: Secure Telegram Login Widget integration
- **AI Commentary**: Custom prompt-based news analysis and commentary
- **Responsive Design**: Optimized for both desktop and mobile experiences

### ⚙️ Backend Infrastructure

- **RSS Monitor**: Automated feed scanning every 5 minutes via Cloudflare Workers
- **AI Summarization**: Intelligent content processing and summary generation
- **Social Integration**: Auto-posting to Twitter/Telegram with OAuth2 authentication
- **Real-time Processing**: WebSocket support for live updates

### 🔧 Technical Stack

- **Frontend**: Next.js, React, TypeScript
- **Backend**: Cloudflare Workers, Prisma ORM
- **Database**: PostgreSQL with Supabase
- **AI**: OpenAI GPT integration
- **Deployment**: Vercel (Frontend), Cloudflare (Workers)
