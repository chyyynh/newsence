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
│   │   │   ├── articles/             # Article cards & layouts
│   │   │   │   └── ArticleCard/variants/  # Platform-specific cards
│   │   │   ├── collections/          # Collection management
│   │   │   ├── auth/                 # Authentication UI
│   │   │   └── ...
│   │   ├── lib/                      # Core libraries
│   │   │   ├── ai/prompts/           # AI Prompt Pipeline System
│   │   │   └── source-handlers/      # Platform-specific handlers
│   │   │       ├── types.ts          # SourceHandler interface & metadata types
│   │   │       ├── registry.ts       # SourceHandlerRegistry class
│   │   │       └── handlers/         # Platform handlers (twitter, youtube...)
│   │   └── store/                    # Zustand state management
│   └── prisma/                       # Database schema
│
├── cf-worker/                        # Cloudflare Workers (Open Source)
│   ├── core/                         # Combined RSS, Twitter & processing
│   ├── crawler/                      # URL scraping service
│   │   └── src/
│   │       ├── index.ts              # Main entry, URL routing
│   │       ├── types.ts              # Request/Response types
│   │       ├── utils/url.ts          # URL detection & extraction
│   │       └── scrapers/             # Platform scrapers
│   │           ├── twitter.ts        # Twitter/X scraper (Kaito API)
│   │           ├── youtube.ts        # YouTube scraper (Data API)
│   │           └── web.ts            # Generic web scraper
│   ├── article-process/              # Content extraction
│   ├── rss-feed-monitor/             # RSS monitoring
│   ├── twitter-monitor/              # Twitter/X monitoring
│   ├── telegram-bot/                 # Telegram integration
│   └── workflow/                     # Workflow orchestration
│
└── script/                           # Utility scripts
```

### Source Handler System (Platform-Specific Cards)

The system supports platform-specific article cards (Twitter, YouTube, GitHub, etc.) through a modular registry pattern.

```
Frontend (Next.js)                          CF Worker (Crawler)
┌─────────────────────────────┐            ┌─────────────────────────────┐
│ lib/source-handlers/        │            │ cf-worker/crawler/src/      │
│ ├── types.ts                │            │ ├── index.ts                │
│ ├── registry.ts             │◄──────────►│ ├── types.ts                │
│ ├── index.ts                │  metadata  │ ├── utils/url.ts            │
│ └── handlers/               │            │ └── scrapers/               │
│     ├── twitter.ts          │            │     ├── twitter.ts          │
│     ├── youtube.ts          │            │     ├── youtube.ts          │
│     └── default.ts          │            │     └── web.ts              │
└─────────────────────────────┘            └─────────────────────────────┘
         │                                          │
         ▼                                          ▼
┌─────────────────────────────┐            ┌─────────────────────────────┐
│ components/articles/        │            │ External APIs               │
│ ArticleCard/variants/       │            │ ├── Kaito (Twitter)         │
│ ├── TwitterArticleContent   │            │ ├── YouTube Data API        │
│ ├── YouTubeArticleContent   │            │ └── Web scraping            │
│ └── DefaultArticleContent   │            └─────────────────────────────┘
└─────────────────────────────┘
```

**Adding a New Platform (e.g., GitHub):**

| Step | Frontend | CF Worker |
|------|----------|-----------|
| 1. URL Detection | Add patterns to `handlers/github.ts` | Update `utils/url.ts` detectUrlType |
| 2. Metadata Type | Add `GitHubMetadata` to `types.ts` | Add to `types.ts` ScrapedContent |
| 3. Handler/Scraper | Create `handlers/github.ts` | Create `scrapers/github.ts` |
| 4. Card Component | Create `GitHubArticleContent.tsx` | N/A |
| 5. Registration | Add to `index.ts` registry | Add case in `index.ts` |

```typescript
// Frontend: handlers/github.ts
export const githubHandler: SourceHandler<GitHubMetadata> = {
  type: 'github',
  urlPatterns: [/github\.com\/[\w-]+\/[\w.-]+/i],
  extractId: (url) => url.match(/github\.com\/([\w-]+\/[\w.-]+)/)?.[1] || null,
  isMetadataComplete: (m) => !!(m?.repoName && m?.ownerName),
  stalenessMs: 6 * 60 * 60 * 1000, // 6 hours
  CardComponent: GitHubArticleContent,
};
```

### AI Prompt Pipeline System

The prompt system uses a modular pipeline architecture for context engineering:

```
frontend/src/lib/ai/prompts/
├── core/
│   ├── types.ts              # Zod schemas + core types
│   ├── token-budget.ts       # Token budget management (Chinese: 1.8 chars/token)
│   └── registry.ts           # Prompt version control
├── pipeline/
│   ├── context-pipeline.ts   # Composable context pipeline
│   └── stages/               # Pipeline stages
│       ├── instruction-stage.ts
│       ├── article-stage.ts
│       ├── citation-stage.ts
│       └── constraint-stage.ts
├── optimization/
│   └── multi-turn-optimizer.ts  # Multi-turn conversation handling
├── templates/
│   └── preset-templates.ts   # Versioned prompt templates
├── testing/
│   └── ab-testing.ts         # A/B testing for prompts
└── instructions/
    └── citation.ts           # Unified citation instructions
```

| Component | Description |
|-----------|-------------|
| **ContextPipeline** | Composable pipeline for building LLM context |
| **TokenBudgetManager** | Unified token estimation with language awareness |
| **PromptRegistry** | Version control for prompt templates |
| **MultiTurnOptimizer** | Handles first message vs follow-up logic |
| **ABTestingService** | A/B testing different prompt versions |

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
