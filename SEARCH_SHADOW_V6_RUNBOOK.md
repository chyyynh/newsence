# AI Search v6 canonical operations

This file began as the #251 shadow-rollout runbook. Its active sections now
define the serving generation-4 contract; generation-3 identifiers and phase-1
shadow artifacts are isolated at the end so they cannot be mistaken for new
operator targets.

## Active contract

| Role | Instance or resource | Durable state | Generation |
| --- | --- | --- | --- |
| Serving AI Search binding | `AI_SEARCH → newsence-corpus-v6` | `public-corpus-v6` | `4 / canonical-4-kind-platform` |
| Rebuild Workflow binding | `SEARCH_INDEX_CANONICAL_REBUILD_WORKFLOW` | — | — |
| Physical rebuild Workflow | `newsence-search-index-canonical-v6-rebuild` | — | — |
| Stable runner | `search-index-rebuild-canonical-4-kind-platform-canonical-v1` | — | — |

The v6 instance has exactly these project-owned custom metadata fields:
`effective_at`, `source_id`, `category`, `kind`, and `resource_platform`.
Canonical null platforms are stored as the reserved text sentinel `none`.

Readiness compares PostgreSQL and AI Search by every searchable content identity
pair:

- `document / none`
- `document / hackernews`
- `post / twitter`
- `video / youtube`
- `paper / none`
- `paper / hackernews`

Image and file resources are private/blob-oriented and do not enter the public
search corpus.

## Workflow isolation

A durable execution replays the graph attached to the physical Cloudflare
Workflow resource that started it. A new runner ID on an old physical resource
does not select a newly deployed graph.

For any incompatible rebuild-graph revision, create all four together:

1. a new binding;
2. a new physical Workflow name;
3. a new exported class;
4. a new source-controlled runner ID.

Never trigger the historical `newsence-search-index-rebuild` or
`newsence-search-index-shadow-rebuild` resources for the active generation.

## One-time #251 terminal repair

The phase-1 shadow run
`search-index-rebuild-canonical-4-kind-platform-shadow-v2` reached its final
readiness fence but errored because its repair listing was limited to one
50-item page. Do not restart or redeploy that historical Workflow. The isolated
repair below is pinned to its terminal source state and to the exact 85-item
target snapshot; any drift fails closed before mutation.

| Role | Identifier |
| --- | --- |
| Worker | `newsence-search-repair-251` |
| Physical Workflow | `newsence-search-index-terminal-repair-251-v2` |
| Runner | `search-index-terminal-repair-251-v2` |
| Config | `wrangler.repair-251.jsonc` |
| Checkpoint | `search-terminal-repair-251.json` |

The repair Worker has no route, `workers.dev` hostname, cron, or R2 binding. It
can reach only v6 AI Search, Hyperdrive, and the production Core's read-only
`getSearchIndexRebuildStatus()` RPC used to fence the errored phase-1 Workflow.

The first isolated physical Workflow,
`newsence-search-index-terminal-repair-251` /
`search-index-terminal-repair-251-v1`, errored with `Worker not found.` before
the Worker ran (`step_count = 0`). It did not claim an epoch or touch AI Search.
It is retained as evidence and must never be restarted. The v2 physical resource
exists so the corrected service-binding graph cannot replay through v1.

Hard ordering gate: keep production Core on compatibility version
`f34f2aaf-1275-4529-b7dd-1b7e94bc44d2` (source `4c0b34f92`) until v2 is
complete and both completion checks below pass. That version's
`getSearchIndexRebuildStatus()` targets the phase-1 shadow Workflow. The final
Core targets the canonical Workflow through the same RPC name, so deploying it
during repair would deliberately fail the final source fence.

From the repository root, validate the pinned source, durable epoch, database
eligibility, target counts, and digest before deployment:

```sh
pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-terminal-repair-251.mjs

pnpm -C workers/core-worker typecheck
pnpm -C workers/core-worker lint
pnpm -C workers/core-worker exec wrangler deploy \
  --config wrangler.repair-251.jsonc \
  --dry-run
```

Deploy only the isolated Worker, confirm the exact runner does not already
exist, then trigger it exactly once:

```sh
pnpm -C workers/core-worker run deploy:search-terminal-repair-251

pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-terminal-repair-251.mjs

pnpm -C workers/core-worker exec wrangler workflows trigger \
  newsence-search-index-terminal-repair-251-v2 \
  '{}' \
  --id search-index-terminal-repair-251-v2
```

Never use a different payload, instance ID, physical Workflow, generation,
epoch, or target digest. The Workflow claims epoch 2, repairs only the pinned
resource identities in batches of at most five, rejects newly introduced
terminal identities, and publishes readiness only after the strict six-pair
contract converges.

One pre-existing v6 item remained in `running` for more than one hour even
though its item log reported a successful seven-chunk reindex. The first
non-namespace single-item PATCH returned the undocumented combination
`success: true, result: null`, produced no new log or last-seen timestamp, and
the next v2 readiness probe still observed the same item as running. Never
repeat that request or treat its null result as a valid ItemSyncResponse.

The one canonical `default` namespace PATCH with `wait_for_completion: true`
also returned `result: null` immediately and produced no progress. REST PATCH
recovery is exhausted; PUT-by-key is intentionally skipped because it supplies
no new bytes or documented stronger reset semantics. The old sync script is
read-only and rejects `--apply`.

The first isolated admission attempt
`newsence-search-index-stuck-item-recovery-251` completed its canonical
read-only preflight, then correctly stopped at `waitForEvent`. The operator
mistakenly required the instance's top-level status to be `waiting`; Cloudflare
reported the event step while retaining a different non-terminal top-level
status. No approval event was sent, no mutation step started, the fixed v1
instance was terminated, and the item ID/status/last-seen/log remained exact.
That Worker/Workflow is never restarted or redeployed. Its immutable evidence
lives in `recoveryHistory`.

The isolated `-v2` attempt recognized the unresolved event step, but the
general instance summary truncated the successful preflight's JSON output.
Parsing failed, so the operator again withheld approval and terminated the
fixed instance before any mutation step. The exact item and log remained
unchanged. That physical deployment is also immutable history. The active
checkpoint uses new `-v3` names and reads step values only through Cloudflare's
dedicated full-step-output endpoint with the exact step name and type; the
endpoint was verified against the completed v2 preflight before v3 deployment.

Recover through a separate one-shot Worker so the active repair Worker and its
pinned v2 graph are never redeployed. The recovery Worker has no route,
workers.dev hostname, cron, R2, or service binding. It can reach only v6 AI
Search and the production database through Hyperdrive. Its single mutation
step has retries disabled, rechecks the exact epoch/item/resource/translation
checkpoint, rebuilds the canonical Markdown and five metadata fields through
the product serializer, then uses the documented same-key `uploadAndPoll`
upsert without deleting the searchable item:

```sh
pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-stuck-item-recovery-251.mjs

pnpm -C workers/core-worker typecheck
pnpm -C workers/core-worker lint
pnpm -C workers/core-worker exec wrangler deploy \
  --config wrangler.stuck-item-recovery-251.jsonc \
  --dry-run

pnpm -C workers/core-worker run deploy:search-stuck-item-recovery-251

pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-stuck-item-recovery-251.mjs \
  --capture-version

# Copy the discovered Workflow versionId and workerVersionId into the matching
# recovery fields in search-stuck-item-251.json, then commit and push that
# exact checkpoint. Never redeploy this one-shot Worker after capture.

pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-stuck-item-recovery-251.mjs \
  --trigger

pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-stuck-item-recovery-251.mjs \
  --verify-complete
```

The pre-deploy check requires the dedicated Workflow to be absent. The capture
check requires it to have exactly one deployed version; the committed
checkpoint and every later preflight require that exact version to remain the
only version. The same capture also pins the sole 100% Worker deployment, and
the Workflow verifies its runtime `version_metadata` binding against that
Worker version before its read-only preflight.

`--trigger` performs the last item/database/deployment checks and the instance
creation in one process. Its write calls use the locally authenticated Wrangler
CLI; the scoped Workflow token remains read-only for the independent fences.
The Workflow stops at a `waitForEvent` gate before its mutation. The operator
sends the approval event only after the created instance reports the pinned
Workflow version, the read-only preflight confirms the pinned Worker version,
the instance reaches that gate, and a final deployment check still finds the
single pinned Workflow and Worker versions. A mismatched or concurrently
redeployed version is terminated without approval. Termination is cleanup, not
the safety boundary; withholding the approval event is the boundary. Run this
while no other operator has deployment authority for the dedicated one-shot
Worker.

If any preflight fence moves, do not deploy or trigger. Never retry an
ambiguous trigger/approval request: inspect the fixed instance ID first. If
`uploadAndPoll` does not return the exact completed item within four minutes,
its Workflow errors without retrying the upsert; inspect the item before
considering the separately designed delete/re-upload last resort.

After recovery completes, let v2 observe the completed item and publish durable
readiness. Then verify the exact repair graph and run the independent strict
current-state rollout check:

```sh
pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-terminal-repair-251.mjs \
  --verify-complete

pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-rollout.mjs
```

Retain the isolated Workflow through the #251 contraction evidence window. Add
its physical name to every queued/running/paused drain; never invoke it again.

## Bootstrap or rebuild

First confirm that the v6 instance exists. Create it only for a fresh
environment; never recreate or replace the production instance:

```sh
pnpm -C workers/core-worker exec wrangler ai-search get newsence-corpus-v6

# Fresh environments only:
pnpm -C workers/core-worker exec wrangler ai-search create \
  newsence-corpus-v6 \
  --type builtin \
  --hybrid-search
```

Run the Core gates and deploy a compatible Worker version before starting a
rebuild:

```sh
pnpm -C workers/core-worker typecheck
pnpm -C workers/core-worker lint
pnpm -C workers/core-worker run deploy
```

Prefer the service-binding RPC `startSearchIndexRebuild()`. The equivalent
operator trigger is:

```sh
pnpm -C workers/core-worker exec wrangler workflows trigger \
  newsence-search-index-canonical-v6-rebuild \
  '{}' \
  --id search-index-rebuild-canonical-4-kind-platform-canonical-v1
```

Before using the explicit trigger, inspect that exact runner and do not start a
second execution concurrently. Transient failures may restart the same
source-compatible runner; a graph change requires a new physical resource as
described above.

The Workflow configures the instance, validates the canonical identity matrix,
uploads the full corpus plus a start-time delta, prunes stale owned items,
repairs retryable terminal items, and marks generation 4 ready only after
PostgreSQL and AI Search converge.

## Verify

Use Node's dotenv parser to load the direct database environment without
printing or shell-sourcing it, then run the active generation-4 checks:

```sh
pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-rebuild.mjs

pnpm -C workers/core-worker exec node \
  --env-file="$PWD/web-tanstack/.env.local" \
  scripts/check-search-rollout.mjs
```

The rollout checker requires explicit `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_AISEARCH_API_TOKEN` environment variables. Use a dedicated token
with `AI Search:Edit` and `AI Search:Run` permissions. The checker never loads
Wrangler OAuth credentials or falls back to `CLOUDFLARE_API_TOKEN`.

The strict rollout check requires:

- durable generation 4 status `ready`;
- zero queued, running, outdated, error, and skipped owned items;
- completed item count equal to the enriched searchable corpus;
- the canonical resource identity constraints validated;
- all six joint kind/platform counts equal between PostgreSQL and AI Search.

Immediately before a schema or reader cutover, also call
`probeSearchIndexCutover()` through the deployed Core service binding. This
fresh probe is independent of the durable ready row and must return `ready:
true` with matching six-pair counts.

## #251 schema contraction sequence

Search readiness does not authorize the database contraction by itself. Follow
`web-tanstack/prisma/251-resource-type-runbook.md` as the source of truth:

1. prove generation 4 ready and complete its observation window;
2. deploy the freeze-aware compatibility Web/Core release while the legacy
   schema, v5 serving, and v6 dual-write contract are still active;
3. quiesce cron/operator starts and drain every pre-contract processing,
   translation, search-rebuild, image-backfill, academic-backfill, and identity
   Workflow resource, including the historical shadow resource;
4. install the writer marker plus database trigger, verify maintenance
   rejection canaries, and repeat the complete Workflow drain;
5. deploy the canonical-only Web first and Core second while writes remain
   frozen;
6. rerun `check:search-rollout` and `probeSearchIndexCutover()`;
7. run the #251 preflight, atomic contract, postflight, final-source drift, and
   active deployment/search/R2 checks;
8. inspect and archive the freeze snapshot/pending reconciliation set, then
   remove the exact writer freeze with the resume script;
9. reconcile any recorded pending IDs through the V2 Workflow and run the
   production writer canaries.

Do not resume writers between the contract and the postflight/final
drift/search/R2 gates. Saved-URL, upload, processing, and deletion canaries are
writer canaries and therefore run only after the exact resume succeeds.

## Failure and rollback

If a rebuild fails before a schema contraction:

1. keep the existing database schema unchanged;
2. inspect only the active canonical runner;
3. repair transient item failures and restart the source-compatible runner, or
   deploy a newly named physical Workflow for a graph change;
4. require the strict rollout check and fresh cutover probe again.

After the #251 contraction, remapping `AI_SEARCH` to v5 is not a standalone
rollback. Restore the exact backed-up database discriminator with the #251
rollback procedure, deploy the compatible Worker versions, verify v5, and only
then remap the binding. Retain `newsence-corpus-v5` and the migration backup
during the declared rollback window.

## Historical generation-3 and phase-1 shadow record

The following identifiers describe generation-3 evidence or the isolated
phase-1 shadow run. They are not active final-contract operator targets:

| Historical role | Identifier |
| --- | --- |
| Generation-3 serving index | `newsence-corpus-v5` |
| Generation-3 durable state | `public-corpus`, `3 / canonical-3-kind` |
| Generation-3 Workflow | `newsence-search-index-rebuild` |
| Phase-1 shadow binding | `AI_SEARCH_NEXT → newsence-corpus-v6` |
| Isolated shadow Workflow | `newsence-search-index-shadow-rebuild` |
| Phase-1 shadow runner | `search-index-rebuild-canonical-4-kind-platform-shadow-v2` |

Historical check scripts, logs, and issue comments may legitimately mention
these exact names. Keep those records labeled as historical instead of
rewriting them into the active contract.
