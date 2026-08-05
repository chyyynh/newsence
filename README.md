<div align="center">

# newsence

**A content discovery engine that helps LLMs understand your world**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![npm: newsence](https://img.shields.io/npm/v/newsence?label=npm%3A%20newsence&color=cb3837&logo=npm)](https://www.npmjs.com/package/newsence)
[![MCP](https://img.shields.io/badge/MCP-Compatible-8A2BE2?logo=anthropic&logoColor=white)](https://www.newsence.app/api/mcp)
[![Website](https://img.shields.io/badge/newsence.app-live-00c853)](https://www.newsence.app)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chyyynh/newsence)

[English](README.md) | [繁體中文](README.zh-TW.md)

</div>

---

## What is newsence?

Ingestion engine for [**newsence.app**](https://www.newsence.app). Pulls contents from RSS / Twitter/X / YouTube / Hacker News / web URLs / uploaded files, runs bilingual AI analysis on each, and stores searchable resources with resource-local entity annotations. Each enriched corpus resource is synchronized to Cloudflare AI Search for retrieval.

## Supported Platforms

![RSS](https://img.shields.io/badge/RSS-F99000?logo=rss&logoColor=white)
![YouTube](https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=white)
![X](https://img.shields.io/badge/X%2FTwitter-000000?logo=x&logoColor=white)
![Hacker News](https://img.shields.io/badge/Hacker%20News-F0652F?logo=ycombinator&logoColor=white)

| Platform             | Type      | Schedule      | What it does                                                                |
| -------------------- | --------- | ------------- | --------------------------------------------------------------------------- |
| **RSS Feeds**        | Monitor   | Every 5 min   | Fetches feeds, deduplicates by URL, detects HN links                        |
| **Twitter/X**        | Monitor   | Every 6 hours | Tracks users via Kaito API — tweets, threads, longform posts, media         |
| **YouTube**          | Monitor   | Every 30 min  | Atom feed → video metadata, transcripts, chapters, AI highlights            |
| **Hacker News**      | Processor | Via RSS       | Detects HN links → fetches comments via Algolia → generates editorial notes |
| **Web**              | Scraper   | Saved URL     | Full content extraction (Readability + Cheerio), OG metadata                |
| **App Inputs**       | Ingestion | Real-time     | Service-binding RPC — saved URL/blob acquisition + enrichment; membership stays app-owned |

All platforms output a unified `NormalizedContent` shape → same AI pipeline.

## How it works

Each resource goes through an automated workflow with independent retries:

```
Content arrives (source monitor / saved URL / uploaded blob / resync)
  │
  ├─ 1. Load Resource ──────── Canonical resources row; acquire URL content or extract uploaded PDF text
  ├─ 2. AI Analysis ────────── AI Gateway text/JSON calls → bilingual title, summary, tags, keywords, entities
  ├─ 3. Save to DB ─────────── Update resources + resource_translations
  ├─    Store Entities ─────── Replace the resource-local resources.entities JSON
  ├─ 4. YouTube Highlights ─── (YouTube only) Transcript → AI highlight segments
  └─ 5. Sync AI Search ─────── Upload the enriched corpus document to Cloudflare AI Search
```

Roughly 30 seconds per resource. Each step retries independently with exponential backoff.

## AI Pipeline

| Stage                   | Model             | What it does                                                                                      |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| **Analysis**          | AI Gateway text model | Resource → bilingual title, summary, tags, keywords, category                                      |
| **Entity Extraction** | AI Gateway JSON model | Resource → named entities (person, organization, product, technology, event, location) with EN + zh-TW names |
| **Retrieval Index**   | Cloudflare AI Search  | Hybrid keyword and semantic retrieval over enriched corpus documents                              |

Translation/summary and classification/entities are separate structured calls so one schema failure does not force the whole resource into fallback.

### Entity Quality Policy

The core worker keeps entity storage deterministic and conservative. It normalizes obvious duplicates, gates known entity types, filters generic tokens and self-source aliases, and caps stored entities per resource.

It intentionally does not perform semantic alias merging in the database. Model families, company/product containment, and alias groups are presentation-layer concerns until they have a reviewed alias source. For example, `google`, `google deepmind`, and `gemini` can be related without being the same canonical database entity.

Entity extraction remains enabled even though the Collection Wiki product surface is retired. The derived annotations live only in `resources.entities` and are retained for future retrieval or presentation work; there is no normalized global entity graph or reverse index.

Add normalized entity tables only when a real product consumer needs cross-resource queries that the resource-local JSON cannot answer cleanly. Potential future additions such as reviewed aliases or extraction-run history should follow that consumer rather than precede it.

## Stack

| Layer         | Technology                                        |
| ------------- | ------------------------------------------------- |
| Runtime       | Cloudflare Workers (V8 isolates)                  |
| Orchestration | Cloudflare Workflows                              |
| Database      | PostgreSQL (via Cloudflare Hyperdrive)            |
| LLM           | Cloudflare AI Gateway                             |
| Search        | Cloudflare AI Search                              |
| Twitter Data  | Kaito API (third-party)                           |

## Self-Hosting

The one-click Deploy button above handles Worker + Workflows, but **Hyperdrive, the database, and secrets need manual setup**. Full walkthrough:

### 1. Database

You need a PostgreSQL instance. Production currently runs on PlanetScale Postgres through Cloudflare Hyperdrive.

The app-owned tables used by core are mirrored in `src/db/schema.ts`. Their canonical definitions live in `web-tanstack/prisma/schema.prisma`, with DB-only constraints and indexes in `web-tanstack/prisma/manual-indexes.sql`. Run `pnpm check:db-schema` after either schema changes.

### 2. Hyperdrive binding

Create a Hyperdrive that points to your database:

```bash
wrangler hyperdrive create newsence-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

Copy the returned ID into `wrangler.jsonc` under the `hyperdrive[].id` field.

### 3. Cloudflare Workflows

Workflows are provisioned automatically on first deploy via the `workflows` bindings in `wrangler.jsonc`.

### 4. Secrets

AI analysis uses the Workers AI binding through AI Gateway, so no external LLM secret is required. Platform/API secrets are required by Wrangler config:

```bash
wrangler secret put KAITO_API_KEY            # Twitter monitoring
wrangler secret put YOUTUBE_API_KEY          # YouTube monitoring
wrangler secret put S2_API_KEY               # Semantic Scholar quota
```

### 5. Deploy

```bash
pnpm install
pnpm run deploy
```

Or run locally with `pnpm dev` (uses `wrangler dev --test-scheduled`, so you can curl `/__scheduled?cron=*/5+*+*+*+*` to trigger RSS manually).

## API surface

The HTTP surface only exposes `GET /health`. App/chat integrations use Cloudflare service-binding RPC with persisted resource IDs, while cron monitors run through scheduled triggers. URL acquisition is an internal stage of the canonical resource workflow.

## Hosted MCP

The newsence app exposes a hosted [MCP](https://modelcontextprotocol.io)
endpoint at `https://www.newsence.app/api/mcp`. The retired local CLI/MCP
package is not part of this Worker.

## Architecture

```
src/
├── index.ts              # Cloudflare WorkerEntrypoint class only
├── ai/                   # Workers AI / AI Gateway helpers
├── entities/             # resource-local entity normalization
├── shared/               # small cross-subsystem primitives
│   ├── types.ts          # ResourceForProcessing, NormalizedContent, YoutubeTranscript
│   └── web.ts            # fetch, URL normalization, stream limits
├── ingest/               # ── resource ingestion pipeline (the open-source core) ──
│   ├── workflow.ts       # Workflow class + enqueueProcessing
│   ├── domain/           # sink and AI merge helpers
│   └── platforms/        # one file per source/stage
│       ├── rss.ts        # feed polling
│       ├── twitter.ts    # monitor + scraper + processor
│       ├── youtube.ts    # monitor + transcript/highlights
│       ├── hackernews.ts # HN processor
│       ├── paper.ts      # Semantic Scholar enrichment stage
│       └── pdf.ts        # PDF text extraction stage
└── corpus.ts              # engine read/search helpers
```

## Environment Variables & Bindings

Bindings (in `wrangler.jsonc`):

| Binding            | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `HYPERDRIVE`       | Hyperdrive connection to your Postgres       |
| `RESOURCE_PROCESSING_V2_WORKFLOW` | Fetch, parse, classify, and persist a canonical resource |
| `RESOURCE_TRANSLATION_V2_WORKFLOW` | Translate a persisted resource into zh-Hant |
| `SEARCH_INDEX_GENERATION_5_REBUILD_WORKFLOW` | Rebuild and verify the generation-5 canonical search index |
| `ACADEMIC_METADATA_BACKFILL_V3_WORKFLOW` | Upgrade explicit DOI/arXiv resources to the current academic metadata schema |
| `R2`               | App-owned uploaded blob reads for PDF extraction |
| `AI`               | Workers AI binding for AI Gateway text calls |
| `AI_SEARCH`        | `newsence-corpus-v6` canonical public corpus |

Secrets (via `wrangler secret put`):

| Variable                       | Required | Description                              |
| ------------------------------ | -------- | ---------------------------------------- |
| `KAITO_API_KEY`                | Yes      | Enables Twitter monitoring               |
| `YOUTUBE_API_KEY`              | Yes      | Enables YouTube channel monitoring       |
| `S2_API_KEY`                   | Yes      | Increases Semantic Scholar quota for paper enrichment |

### Canonical AI Search v6

`AI_SEARCH` serves `newsence-corpus-v6`. Its five custom metadata fields are
`effective_at`, `source_id`, `category`, `kind`, and `resource_platform`; null
platforms use the reserved `none` sentinel. Durable readiness lives in
`search_index_states` as `public-corpus-v6`, generation
`5 / canonical-5-blog-forum-kind`.

The canonical rebuild verifies every searchable identity pair, not only totals:
`blog / none`, `forum / hackernews`, `post / twitter`,
`video / youtube`, `paper / none`, and `paper / hackernews`. It waits for all
owned items to leave queued, running, outdated, error, and skipped states, then
compares AI Search with PostgreSQL before marking the generation ready.

Run the static gates, start the generation-specific Workflow through
`startSearchIndexRebuild()`, and poll
`getSearchIndexRebuildStatus(instanceId)`. The equivalent operator trigger is:

```sh
pnpm exec wrangler workflows trigger \
  newsence-search-index-generation-5-rebuild \
  '{}' \
  --id search-index-rebuild-canonical-5-blog-forum-kind-canonical-v1

pnpm check:search-rebuild
pnpm check:search-rollout
```

`check:search-rollout` talks directly to the AI Search REST API and deliberately
does not reuse Wrangler OAuth credentials. Set `CLOUDFLARE_ACCOUNT_ID` and a
dedicated `CLOUDFLARE_AISEARCH_API_TOKEN` with `AI Search:Edit` and
`AI Search:Run` permissions in the operator environment before running it.

Immediately before a reader or schema cutover, call
`probeSearchIndexCutover()` for an independent six-pair DB/index comparison.
Cloudflare Workflow executions replay the graph attached to their physical
Workflow resource, so incompatible graph revisions require a new binding,
resource name, class, and runner ID; changing only a runner ID is not isolation.
See `AI_SEARCH_V6_RUNBOOK.md` for the active rebuild and verification
procedure.

Generation 5 is a breaking database and reader contract, not a rolling
compatible deploy. In production, pause ingest and app-owned resource writes,
drain processing/translation/academic/search Workflows, run
`web-tanstack/prisma/migrate-resource-kinds-blog-forum.sql`, deploy Core and Web
while writes remain paused, then complete the full generation-5 rebuild and
verification before resuming writes. Do not expose old binaries to the migrated
schema, or new binaries to the legacy `document` rows, outside that coordinated
maintenance window.

#### Historical generation evidence

`newsence-corpus-v5`, durable state `public-corpus`, generation
`3 / canonical-3-kind`, and `newsence-search-index-rebuild` belong to the
completed #245 rollout. Historical scripts and logs retain those exact names as
evidence. Generation 4 used `canonical-4-kind-platform` and
`newsence-search-index-canonical-v6-rebuild`. These historical Workflow
resources are not active bindings and must not be triggered or adopted for the
generation-5 contract.

### Academic metadata backfill

After deploying an academic metadata schema change, trigger the versioned
Workflow through the core service-binding RPC `startAcademicMetadataBackfill()`,
or directly with Wrangler:

```sh
pnpm exec wrangler workflows trigger newsence-academic-metadata-backfill-v3 '{}'
```

The Workflow keyset-pages only through explicit `doi.org` and arXiv
`/abs`, `/html`, or `/pdf` resources that are missing the current
`schemaVersion`. Each Semantic Scholar request and database write is an
independent durable step, with a one-second request interval. Successful
provider responses atomically replace only `enrichments.academic` and fill a
missing exact publication date. Provider failures preserve legacy metadata;
reruns automatically skip already-upgraded rows.

## Adding an Ingest Adapter

Ingest adapters live in `ingest/platforms/*.ts` with the
discovery/scrape/process pieces they actually need. App-owned saved URLs create
`resources` plus `resource_saves`; uploads create `resources` plus `user_files`.
The workflow receives a `resourceId`. SQL writes stay in
`ingest/domain/resource-store.ts`.

Keep the axes separate: acquisition (`rss`, `web`, or a specialized adapter) is
not canonical `ResourcePlatform` (`youtube`, `twitter`, `hackernews`, or null),
`ResourceKind` (`blog`, `forum`, `post`, `video`, `paper`, `image`, `file`), blob
representation (MIME/filename/size/pages), or lifecycle origin (`source`,
`saved_url`, `upload`, `generated`). PDF extraction and Semantic Scholar paper
enrichment are workflow stages keyed from row content/metadata, not additional
identity values.

Monitored `Source.kind` (`blog` or `news`) remains a separate feed/editorial
classification. Both source kinds produce the canonical `blog` resource shell;
the source classification may change feed copy or filtering, but never the
resource identity.

Minimum to add a new ingest source:

1. **Adapter file** (`ingest/platforms/foo.ts`) — discovery/scrape helpers and optional custom processor.
2. **Metadata shape** — add only the platform-specific JSON payload needed by `platform_metadata`.
3. **Monitor** (optional) — if the source is pollable, wire its cron handler from `src/index.ts`.
4. **Workflow hook** (optional) — only if the source needs behavior beyond the default AI merge.

The new resource goes through the same Workflow pipeline as every other ingest
source. Add a new canonical platform value only when the product needs durable
platform-specific behavior or presentation; an RSS feed or ordinary web page
does not qualify.

## License

MIT
