# AI Search v6 operations

This runbook covers the active canonical AI Search instance and rebuild
Workflow. Completed #245/#251 rollout and one-shot repair procedures live in Git
history and the closed issues, not in the current operator surface.

## Active contract

| Role | Instance or resource | Durable state | Generation |
| --- | --- | --- | --- |
| Serving binding | `AI_SEARCH → newsence-corpus-v6` | `public-corpus-v6` | `5 / canonical-5-blog-forum-kind` |
| Rebuild binding | `SEARCH_INDEX_GENERATION_5_REBUILD_WORKFLOW` | — | — |
| Physical Workflow | `newsence-search-index-generation-5-rebuild` | — | — |
| Entrypoint class | `SearchIndexGeneration5RebuildWorkflow` | — | — |
| Stable runner | `search-index-rebuild-canonical-5-blog-forum-kind-canonical-v1` | — | — |
| Durable step namespace | `generation-5` | — | — |

The v6 instance owns exactly five custom metadata fields:
`effective_at`, `source_id`, `category`, `kind`, and `resource_platform`.
Canonical null platforms are stored as the reserved text sentinel `none`.

Readiness compares PostgreSQL and AI Search for every searchable identity pair:

- `blog / none`
- `forum / hackernews`
- `post / twitter`
- `video / youtube`
- `paper / none`
- `paper / hackernews`

Private image and file resources are not part of the public search corpus.

## Workflow graph isolation

Cloudflare Workflow executions replay the graph attached to the physical
Workflow resource that started them. A new runner ID on an existing physical
resource does not select newly deployed code.

For an incompatible rebuild graph revision, create all four together:

1. a new binding;
2. a new physical Workflow name;
3. a new exported `WorkflowEntrypoint` class;
4. a new source-controlled runner ID.

Never trigger historical generation-3/generation-4, shadow-rollout, or one-shot
repair Workflow resources. Local source cleanup does not delete their remote
execution history.

## Coordinated `document` to `blog`/`forum` cutover

Generation 5 changes the persisted database vocabulary and every reader/writer
that consumes it. It is intentionally breaking: an old binary cannot safely
write the migrated schema, and a new binary cannot safely consume legacy
`document` rows. Use one maintenance window; do not attempt a rolling deploy.

Before the window:

1. run the Core and Web static gates and build the exact commits to deploy;
2. rehearse `web-tanstack/prisma/migrate-resource-kinds-blog-forum.sql` against
   a representative database and confirm its preflight passes;
3. confirm the generation-5 binding, physical Workflow, class, runner, and
   `generation-5` step names match the active contract above;
4. confirm no generation-5 rebuild is already running.

During the window:

1. pause source cron acquisition plus app URL-save, upload, resync, and other
   resource writes;
2. drain resource-processing, translation, academic-backfill, and search-index
   Workflows so no legacy writer remains;
3. run the dedicated migration through the direct PostgreSQL connection:

   ```sh
   /opt/homebrew/opt/libpq/bin/psql \
     "$CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE" \
     -X -v ON_ERROR_STOP=1 \
     -f web-tanstack/prisma/migrate-resource-kinds-blog-forum.sql
   ```

4. verify there are no `kind='document'` rows and that every row satisfies the
   new identity matrix;
5. while writes remain paused, deploy Core first and Web immediately after it;
6. trigger the generation-5 full rebuild, then run both strict checks and
   `probeSearchIndexCutover()`;
7. smoke the production feed/detail/MCP paths for blog, forum, post, video, and
   both paper identities;
8. resume writes and cron only after the database, deployed readers/writers, AI
   Search, and real API paths all agree.

The migration maps `document / hackernews` to `forum / hackernews` and all
other legacy `document` rows to `blog / null`; existing `paper` rows stay
papers. A full AI Search rebuild is mandatory because the existing indexed item
metadata still contains the legacy kind values.

## Bootstrap or rebuild

Confirm that the v6 instance exists. Create it only in a fresh environment;
never recreate or replace the production instance.

```sh
pnpm -C workers/core-worker exec wrangler ai-search get newsence-corpus-v6

# Fresh environments only:
pnpm -C workers/core-worker exec wrangler ai-search create \
  newsence-corpus-v6 \
  --type builtin \
  --hybrid-search
```

Run the Core gates before starting a rebuild. In production, deploy only at the
coordinated point in the cutover above; in a fresh environment, deploy a
schema-compatible Worker first:

```sh
pnpm -C workers/core-worker typecheck
pnpm -C workers/core-worker lint
pnpm -C workers/core-worker run deploy
```

Prefer the service-binding RPC `startSearchIndexRebuild()`. The equivalent
operator trigger is:

```sh
pnpm -C workers/core-worker exec wrangler workflows trigger \
  newsence-search-index-generation-5-rebuild \
  '{}' \
  --id search-index-rebuild-canonical-5-blog-forum-kind-canonical-v1
```

Inspect that exact runner before an explicit trigger. Do not start a second
execution concurrently. A transient failure may restart the same
source-compatible runner; a graph change requires the isolation sequence above.

The Workflow configures the instance, validates the identity matrix, uploads
the full corpus plus a start-time delta, prunes stale owned items, repairs
retryable terminal items, and marks generation 5 ready only after PostgreSQL and
AI Search converge.

## Verify

Load the direct database environment without printing it, then run both active
checks:

```sh
pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env" \
  scripts/check-search-rebuild.mjs

pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env" \
  scripts/check-search-rollout.mjs
```

`check-search-rollout.mjs` requires explicit `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_AISEARCH_API_TOKEN` variables. Use a dedicated token with AI Search
Edit and Run permissions. The checker does not reuse Wrangler OAuth
credentials.

The strict rollout check requires:

- durable generation 5 status `ready`;
- zero queued, running, outdated, error, and skipped owned items;
- completed item count equal to the enriched searchable corpus;
- canonical resource identity constraints;
- matching PostgreSQL and AI Search counts for all six identity pairs.

Before a reader or schema change, also call `probeSearchIndexCutover()` through
the deployed Core service binding. This fresh probe is independent of the
durable ready row.

## Failure handling

If a rebuild fails:

1. inspect only the active canonical runner and its failed step;
2. leave the serving instance and migrated database schema intact, and keep
   resource writes paused during a cutover;
3. restart the same runner only for a transient, source-compatible failure;
4. deploy a newly isolated physical Workflow for any graph change;
5. require both verification checks and the fresh cutover probe again.

Do not revive the removed #251 single-item or terminal-repair tooling. The
canonical rebuild owns current retry, stale-item pruning, convergence, and
readiness behavior. Remote retirement of historical Workflow or Worker
resources is a separate destructive operation and must follow an explicit
nonterminal-instance audit.
