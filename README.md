# Newsence

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/chyyynh/Newsence)
[![Website](https://img.shields.io/badge/Website-newsence.xyz-blue?style=flat-square)](https://app.newsence.xyz)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/newsence/tree/main/cf-worker/core)

## Collective Memory Search Engine

Newsence is a knowledge management platform built around the concept of **Collective Memory**. We believe knowledge should not exist as isolated fragments, but as an organic network formed through **citations** and **connections**.

### Vision

In an age of information overload, we consume countless news articles, reports, and research papers daily—yet most of this information fades from memory after reading. Newsence aims to weave these scattered knowledge fragments into a **Collective Memory** network through the power of community collaboration.

## Core Concepts

```
                    ┌─────────────┐
                    │   社群      │
                    │  Community  │
                    └──────┬──────┘
                           │ 協作
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │  收藏   │◄─────►│  文稿   │◄─────►│  標籤   │
   │Collection│      │Document │       │  Tag    │
   └─────────┘       └────┬────┘       └─────────┘
                          │
                    引用 Citation
                    (關係/連結)
                          │
                    ┌─────┴─────┐
                    ▼           ▼
               ┌─────────┐ ┌─────────┐
               │  文稿   │ │  文稿   │
               │Document │ │Document │
               └─────────┘ └─────────┘
                          │
                          ▼
                  ┌───────────────┐
                  │   集體記憶    │
                  │Collective Memory│
                  └───────────────┘
```

| Concept | 中文 | Description |
|---------|------|-------------|
| **Document** | 文稿 | 核心內容單位 - 文章、筆記、研究報告 |
| **Citation** | 引用 | 文稿之間的關係連結，形成知識網絡 |
| **Collection** | 收藏 | 將相關文稿組織成主題集合 |
| **Tag** | 標籤 | 分類與標記，便於檢索 |
| **Community** | 社群 | 使用者協作，共同建構知識 |
| **Collective Memory** | 集體記憶 | 從所有連結中浮現的知識網絡 |

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (Next.js)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │  Editor  │  │ Explorer │  │Collection│  │  Search  │        │
│  │ (Lexical)│  │(Knowledge│  │  Manager │  │  Engine  │        │
│  │          │  │  Graph)  │  │          │  │          │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API Layer (Next.js API)                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Articles │  │Resources │  │Collections│ │   Auth   │        │
│  │   API    │  │   API    │  │    API   │  │(Better   │        │
│  │          │  │          │  │          │  │  Auth)   │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Cloudflare Workers (Edge)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │   RSS    │  │ Article  │  │ Twitter  │  │ Telegram │        │
│  │ Monitor  │  │ Process  │  │ Monitor  │  │   Bot    │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│         │            │             │             │              │
│         └────────────┴─────────────┴─────────────┘              │
│                              │                                   │
│                        Queues & Workflows                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Database (Supabase)                          │
│  ┌──────────────────────────────────────────────────────┐       │
│  │                    PostgreSQL                         │       │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐ │       │
│  │  │Documents│  │Citations│  │Collections│ │  Users  │ │       │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘ │       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | Next.js 15, React 19, Zustand, Motion, Lexical Editor |
| **Backend** | Cloudflare Workers, Next.js API Routes |
| **Database** | PostgreSQL (Supabase), Prisma ORM |
| **Auth** | Better Auth |
| **AI** | OpenAI, Anthropic Claude |
| **Payments** | Polar.sh |
| **Analytics** | Statsig |

## Project Structure

```
.
├── frontend/                         # Next.js Frontend Application
│   ├── src/
│   │   ├── app/                      # App Router pages
│   │   ├── components/               # React components
│   │   │   ├── article/              # Article editor (Lexical)
│   │   │   ├── collections/          # Collection management
│   │   │   ├── auth/                 # Authentication UI
│   │   │   └── ...
│   │   ├── lib/                      # Core libraries
│   │   └── store/                    # Zustand state management
│   └── prisma/                       # Database schema
│
├── cf-worker/                        # Cloudflare Workers (Open Source)
│   ├── core/                         # Combined RSS, Twitter & processing
│   ├── article-process/              # Content extraction
│   ├── rss-feed-monitor/             # RSS monitoring
│   ├── twitter-monitor/              # Twitter/X monitoring
│   ├── telegram-bot/                 # Telegram integration
│   └── workflow/                     # Workflow orchestration
│
└── script/                           # Utility scripts
```

## Features

### Core Features

- **Smart Collecting**: Save any web resource and let AI extract key information
- **Citation Network**: Build knowledge graphs through document citations
- **Collections**: Organize documents into themed collections
- **AI Remix**: Transform your feed into newsletters, social posts, or research summaries

### Editor

- Rich text editing powered by Lexical
- Inline citation support
- Resource embedding
- Real-time collaboration (coming soon)

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

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

```bash
# Deploy all workers
pnpm run deploy

# Deploy individual worker
pnpm run deploy:article-process
```

## Documentation

| Document | Description |
|----------|-------------|
| [QUICK-START.md](./QUICK-START.md) | 5-minute quick start |
| [WORKERS.md](./WORKERS.md) | Complete workers guide |
| [CICD-SETUP.md](./CICD-SETUP.md) | CI/CD setup (10 min) |
| [ENV-SETUP.md](./ENV-SETUP.md) | Environment variables |

## License

This open source repo only contains Cloudflare Workers for monitoring news, article processing, and social posting. The frontend application is not open source.

---

<p align="center">
  <strong>Newsence</strong> — Where knowledge finds context.
</p>
