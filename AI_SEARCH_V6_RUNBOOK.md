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

## Database prerequisite

Generation 5 serves only the current canonical `blog`/`forum` identity matrix.
The completed `document` cutover and its one-shot SQL live in git history. Do
not run this rebuild against a database that fails the current schema and
resource-identity gates.

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

Run the Core gates before starting a rebuild. A fresh environment needs the
current schema and a schema-compatible Worker first:

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
AI Search converge. Terminal-item repair is per item: a native
`items.get(id).sync()` re-index when the stored document is current, or a
re-upload when the DB row is newer than the stored document. The binding's
`sync()` returns null at runtime despite its declared type — observed state
comes from a follow-up `info()`.

## Verify

Inspect the exact Workflow instance with Wrangler, then load the direct database
environment without printing it and run the authoritative rollout check:

```sh
pnpm -C workers/core-worker exec wrangler workflows instances describe \
  newsence-search-index-generation-5-rebuild \
  search-index-rebuild-canonical-5-blog-forum-kind-canonical-v1

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
2. leave the serving instance and current database schema intact;
3. restart the same runner only for a transient, source-compatible failure;
4. deploy a newly isolated physical Workflow for any graph change;
5. require the native Workflow inspection, rollout check, and fresh cutover
   probe again.

Do not revive the removed #251 single-item or terminal-repair tooling. The
canonical rebuild owns current retry, stale-item pruning, convergence, and
readiness behavior. Remote retirement of historical Workflow or Worker
resources is a separate destructive operation and must follow an explicit
nonterminal-instance audit.
