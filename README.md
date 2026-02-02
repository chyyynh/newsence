# Newsence

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/chyyynh/Newsence)
[![Website](https://img.shields.io/badge/Website-newsence.xyz-blue?style=flat-square)](https://app.newsence.xyz)

A knowledge management platform that turns scattered news and articles into a connected knowledge network through citations and collections.

## Features

- **Document Editor** — Rich text editing powered by Lexical with inline citations and resource embedding
- **AI Assistant** — Chat-based AI that searches news, fetches articles, generates images, and creates documents
- **Citation Network** — Link documents, articles, and collections to build a knowledge graph
- **Multi-Platform Support** — Platform-specific cards for Twitter, YouTube, HackerNews, and more
- **Collections** — Organize resources into themed collections
- **Source Monitoring** — Automated RSS, Twitter, and Telegram monitoring via Cloudflare Workers

## Architecture

```
frontend/          Next.js 15 web application
cf-worker/         Cloudflare Workers (open source)
├── core/          RSS + Twitter monitoring & article processing
├── crawler/       URL scraping service (Twitter, YouTube, web)
├── telegram-bot/  Telegram integration
└── workflow/      Workflow orchestration
script/            Utility scripts
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind CSS v4 |
| Editor | Lexical |
| State | Zustand, TanStack Query |
| AI | Vercel AI SDK v6, Google Gemini, OpenAI, Anthropic Claude |
| Backend | Next.js API Routes, Cloudflare Workers |
| Database | PostgreSQL (Supabase), Prisma ORM |
| Auth | Better Auth |

## License

This repo contains open-source Cloudflare Workers for news monitoring, article processing, and social posting. The frontend application is not open source.

---

<p align="center">
  <strong>Newsence</strong> — Where knowledge finds context.
</p>
