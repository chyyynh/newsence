# AI Search v6 shadow rollout

This is the non-serving preparation phase for resource identity contraction
(#251). Production search continues to read `newsence-corpus-v5` through
`AI_SEARCH`. The rebuild, canonical metadata checks, and readiness state in this
runbook apply only to `newsence-corpus-v6` through `AI_SEARCH_NEXT`.

## Contracts

| Role | Instance | Durable state | Generation | Metadata identity |
| --- | --- | --- | --- | --- |
| Current reader | `newsence-corpus-v5` | `public-corpus` | `3 / canonical-3-kind` | `type` + `kind` |
| Shadow candidate | `newsence-corpus-v6` | `public-corpus-v6` | `4 / canonical-4-kind-platform` | `kind` + `resource_platform` |

The shadow instance has exactly five custom metadata fields:
`effective_at`, `source_id`, `category`, `kind`, and `resource_platform`.
Canonical null platforms are stored as the reserved text sentinel `none`.

Shadow readiness compares the database and AI Search by every valid content
identity pair, not only by kind:

- `document / none`
- `document / hackernews`
- `post / twitter`
- `video / youtube`
- `paper / none`
- `paper / hackernews`

## One-time preparation

Create the built-in shadow instance before deploying a Worker version that
contains the `AI_SEARCH_NEXT` binding:

```sh
pnpm -C workers/core-worker exec wrangler ai-search create \
  newsence-corpus-v6 \
  --type builtin \
  --hybrid-search
```

The rebuild Workflow applies the exact RRF, trigram, and custom metadata
configuration before uploading the corpus. Do not update the v5 schema.

## Deploy and start

Run the ordinary Core static gates and deploy. Verify that the serving v5
contract is still ready before starting the shadow rebuild:

```sh
set -a
. web-tanstack/.env.local
set +a

pnpm -C workers/core-worker typecheck
pnpm -C workers/core-worker lint
pnpm -C workers/core-worker check:search-rollout
pnpm -C workers/core-worker run deploy
```

Trigger the fresh generation-4 runner exactly once:

```sh
pnpm -C workers/core-worker exec wrangler workflows trigger \
  newsence-search-index-shadow-rebuild \
  '{"mode":"rebuild"}' \
  --id search-index-rebuild-canonical-4-kind-platform-shadow-v2
```

Normal resource synchronization writes the serving index first and then the
shadow index. Deletions follow the same order. A shadow failure is retryable,
but the current v5 document is already refreshed before that failure surfaces.
The full rebuild, stale-item prune, repair, and readiness probes operate only on
v6.

## Observe and verify

During the rebuild, run both checks. The first protects the serving contract;
the second validates v6 configuration, state fencing, database invariants, and
progress:

```sh
pnpm -C workers/core-worker check:search-rollout
pnpm -C workers/core-worker check:search-shadow-rollout -- --allow-in-progress
```

After the Workflow is complete, remove the progress flag:

```sh
pnpm -C workers/core-worker check:search-rollout
pnpm -C workers/core-worker check:search-shadow-rollout
```

The strict shadow check requires generation 4 to be ready, every non-completed
item status to be zero, the completed count to equal the enriched content
corpus, the database identity invariants to remain zero, and the matrix
constraint to remain validated. The Workflow marks the state ready only after
AI Search's joint kind/platform counts equal the database counts.

## Failure and rollback

Phase 1 does not route reads to v6 and does not change the database schema. If
the shadow build fails:

1. Leave v5 and its `public-corpus` state untouched.
2. Inspect or terminate only
   `search-index-rebuild-canonical-4-kind-platform-shadow-v2`.
3. Fix the shadow path and start a new source-controlled runner suffix rather
   than replaying incompatible durable history.
4. If necessary, roll back the Core deployment to stop dual writes; v5 remains
   the serving index throughout.

Do not remap `AI_SEARCH` to v6 or drop the legacy database column in this phase.
Those are separate cutover and contraction actions after the shadow observation
gate passes.
