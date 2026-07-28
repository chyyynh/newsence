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
| `RESOURCE_PROCESSING_WORKFLOW` | Fetch, parse, classify, and persist a resource |
| `RESOURCE_TRANSLATION_WORKFLOW` | Translate a persisted resource into zh-Hant |
| `SEARCH_INDEX_REBUILD_WORKFLOW` | Rebuild the complete search index from Postgres |
| `RECENT_RESOURCE_IMAGE_BACKFILL_WORKFLOW` | Warm recent public resource images into app-owned R2 |
| `ACADEMIC_METADATA_BACKFILL_WORKFLOW` | Upgrade explicit DOI/arXiv resources to the current academic metadata schema |
| `R2`               | App-owned uploaded blob reads for PDF extraction |
| `AI`               | Workers AI binding for AI Gateway text calls |
| `AI_SEARCH`        | Cloudflare AI Search corpus namespace        |

Secrets (via `wrangler secret put`):

| Variable                       | Required | Description                              |
| ------------------------------ | -------- | ---------------------------------------- |
| `KAITO_API_KEY`                | Yes      | Enables Twitter monitoring               |
| `YOUTUBE_API_KEY`              | Yes      | Enables YouTube channel monitoring       |
| `S2_API_KEY`                   | Yes      | Increases Semantic Scholar quota for paper enrichment |

### Search index rebuild and reader cutover

The resource-identity dual-read index uses exactly five custom metadata fields:
`effective_at`, `source_id`, `type`, `category`, and `kind`. Cloudflare AI
Search currently limits an instance to five custom fields, so
`resource_platform` remains represented by the verified legacy-type proxy until
the #251 contract rebuild replaces `type`.

Roll out an index schema change in this order:

1. Apply and validate the database identity backfill.
2. Apply `web-tanstack/prisma/245-search-index-readiness.sql`, then deploy Core
   so new uploads carry the new metadata while the durable generation row is
   still absent and kind-native reads fail closed to legacy `types`.
3. Call `startSearchIndexRebuild()` and poll
   `getSearchIndexRebuildStatus(instanceId)`.
4. Deploy app/MCP readers that send `kinds` or `resourcePlatforms`. They use
   native `kind` filters only after the current generation atomically reaches
   `ready`; Workflow history retention is not part of the serving contract.

The rebuild preflights missing identities and legacy platform-proxy drift. It
does not report success merely because uploads were queued: it waits until all
`resources/` items have no queued, running, outdated, error, or skipped status,
then compares total and per-kind index counts with Postgres. This terminal
success writes the durable reader-cutover gate.

If a pre-gate Workflow execution already completed the same physical index
contract, deploy the migration and current Core version, then adopt that exact
terminal instance without uploading the corpus again:

```sh
pnpm exec wrangler workflows trigger \
  newsence-search-index-rebuild \
  '{"mode":"adopt","completedInstanceId":"search-index-rebuild-canonical-3-kind"}' \
  --id search-index-adopt-canonical-3-kind
```

Adoption remains fail closed: it checks the source Workflow is complete, the
live index configuration matches, all owned item statuses are settled, and
Postgres/index totals agree for every kind before marking the generation ready.

### Recent resource image warmup

New ingest eagerly rehosts every trusted resource image through the app Worker's
`DomainRpc`. After deploying a change to this pipeline, warm the homepage window
with a bounded Workflow run:

```sh
pnpm exec wrangler workflows trigger newsence-recent-resource-image-backfill '{"days":7}'
```

The Workflow accepts only 1–7 days, pages through enriched public corpus rows by
effective date, and is safe to rerun because R2 keys are content-addressed. Older
rows are intentionally not scanned; their first image request uses the resource
row to validate and lazily rehost an R2 miss.

### Academic metadata backfill

After deploying an academic metadata schema change, trigger the versioned
Workflow through the core service-binding RPC `startAcademicMetadataBackfill()`,
or directly with Wrangler:

```sh
pnpm exec wrangler workflows trigger newsence-academic-metadata-backfill '{}'
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
`ResourceKind` (`document`, `post`, `video`, `paper`, `image`, `file`), blob
representation (MIME/filename/size/pages), or lifecycle origin (`source`,
`saved_url`, `upload`, `generated`). PDF extraction and Semantic Scholar paper
enrichment are workflow stages keyed from row content/metadata, not additional
identity values.

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
