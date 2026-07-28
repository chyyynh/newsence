import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const INDEX_NAME = 'newsence-corpus-v5';
const STATE_INDEX_NAME = 'public-corpus';
const GENERATION = 3;
const GENERATION_KEY = 'canonical-3-kind';
const ALLOW_IN_PROGRESS = process.argv.includes('--allow-in-progress');
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTENT_KINDS = ['document', 'post', 'video', 'paper'];
const EXPECTED_CUSTOM_METADATA = [
	{ field_name: 'effective_at', data_type: 'datetime' },
	{ field_name: 'source_id', data_type: 'text' },
	{ field_name: 'type', data_type: 'text' },
	{ field_name: 'category', data_type: 'text' },
	{ field_name: 'kind', data_type: 'text' },
];
const TERMINAL_ITEM_STATES = ['queued', 'running', 'error', 'skipped', 'outdated'];

function runWranglerJson(args) {
	const result = spawnSync('pnpm', ['exec', 'wrangler', ...args, '--json'], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-search-rollout-check.log',
		},
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`wrangler ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
	}
	return JSON.parse(result.stdout);
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	if (!value) {
		throw new Error(
			'Set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE, DIRECT_URL, or DATABASE_URL before checking rollout state',
		);
	}
	const url = new URL(value);
	// libpq accepts `sslrootcert=system`; node-postgres treats the value as a
	// filename. Removing only that sentinel retains `sslmode=verify-full` while
	// using Node's system trust store.
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

const instance = runWranglerJson(['ai-search', 'get', INDEX_NAME]);
assert.equal(instance.id, INDEX_NAME, 'AI Search instance');
assert.equal(instance.engine_version, 3, 'AI Search engine generation');
assert.equal(instance.enable, true, 'AI Search enabled');
assert.equal(instance.paused, false, 'AI Search paused');
assert.deepEqual(instance.custom_metadata, EXPECTED_CUSTOM_METADATA, 'AI Search custom metadata contract');

const stats = runWranglerJson(['ai-search', 'stats', INDEX_NAME]);
assert.equal(typeof stats.completed, 'number', 'AI Search completed count');
for (const state of TERMINAL_ITEM_STATES) {
	assert.equal(typeof stats[state], 'number', `AI Search ${state} count`);
	if (!ALLOW_IN_PROGRESS) assert.equal(stats[state], 0, `AI Search ${state} items`);
}

const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();
let state;
let expected;
let identityInvariants;
try {
	const stateResult = await client.query(
		`SELECT index_name, generation, generation_key, status, rebuild_epoch, rebuilding_at, ready_at, updated_at
		   FROM search_index_states
		  WHERE index_name = $1`,
		[STATE_INDEX_NAME],
	);
	const expectedResult = await client.query(
		`SELECT kind, COUNT(*)::int AS count
			   FROM resources
			  WHERE scope = 'corpus'
			    AND enrichment_status = 'enriched'
			    AND kind = ANY($1::text[])
			  GROUP BY kind
			  ORDER BY kind`,
		[CONTENT_KINDS],
	);
	const invariantResult = await client.query(
		`WITH expected AS (
			   SELECT
			     kind,
			     resource_platform,
			     CASE
			       WHEN type = 'twitter' THEN 'post'
			       WHEN type = 'youtube' THEN 'video'
			       WHEN type = 'image' THEN 'image'
			       WHEN type = 'file' THEN 'file'
			       WHEN type IN ('web', 'rss', 'pdf', 'hackernews')
			         AND COALESCE(platform_metadata #>> '{enrichments,academic,source}', '') = 'semanticscholar'
			         THEN 'paper'
			       ELSE 'document'
			     END AS expected_kind,
			     CASE
			       WHEN type = 'twitter' THEN 'twitter'
			       WHEN type = 'youtube' THEN 'youtube'
			       WHEN type = 'hackernews' THEN 'hackernews'
			       ELSE NULL
			     END AS expected_platform
			   FROM resources
			   WHERE enrichment_status = 'enriched'
			 )
			 SELECT
			   (SELECT COUNT(*)::int FROM resources WHERE kind IS NULL) AS null_kind,
			   (SELECT COUNT(*)::int
			      FROM resources
			     WHERE kind NOT IN ('document', 'post', 'video', 'paper', 'image', 'file')) AS invalid_kind,
			   (SELECT COUNT(*)::int
			      FROM resources
			     WHERE resource_platform IS NOT NULL
			       AND resource_platform NOT IN ('hackernews', 'twitter', 'youtube')) AS invalid_platform,
			   (SELECT COUNT(*)::int
			      FROM resources
			     WHERE NOT ((
			       (kind IS NULL AND resource_platform IS NULL)
			       OR (kind = 'document' AND resource_platform IS NULL)
			       OR (kind = 'document' AND resource_platform = 'hackernews')
			       OR (kind = 'post' AND resource_platform = 'twitter')
			       OR (kind = 'video' AND resource_platform = 'youtube')
			       OR (kind = 'paper' AND resource_platform IS NULL)
			       OR (kind = 'paper' AND resource_platform = 'hackernews')
			       OR (kind = 'image' AND resource_platform IS NULL)
			       OR (kind = 'file' AND resource_platform IS NULL)
			     ) IS TRUE)) AS invalid_matrix,
			   (SELECT COUNT(*)::int
			      FROM expected
			     WHERE kind IS DISTINCT FROM expected_kind
			        OR resource_platform IS DISTINCT FROM expected_platform) AS enriched_legacy_drift`,
	);
	const constraintResult = await client.query(
		`SELECT convalidated
			   FROM pg_constraint
			  WHERE conrelid = 'resources'::regclass
			    AND conname = 'resources_kind_platform_check'`,
	);
	assert.equal(stateResult.rowCount, 1, 'durable search generation row');
	[state] = stateResult.rows;
	const byKind = Object.fromEntries(CONTENT_KINDS.map((kind) => [kind, 0]));
	for (const row of expectedResult.rows) {
		assert.ok(CONTENT_KINDS.includes(row.kind), `expected content kind ${row.kind}`);
		assert.equal(typeof row.count, 'number', `expected ${row.kind} count`);
		byKind[row.kind] = row.count;
	}
	expected = {
		total: Object.values(byKind).reduce((total, count) => total + count, 0),
		byKind,
	};
	assert.equal(invariantResult.rowCount, 1, 'resource identity invariant row');
	[identityInvariants] = invariantResult.rows;
	for (const [name, count] of Object.entries(identityInvariants)) {
		assert.equal(count, 0, `resource identity invariant ${name}`);
	}
	assert.equal(constraintResult.rowCount, 1, 'resource identity matrix constraint');
	assert.equal(constraintResult.rows[0].convalidated, true, 'resource identity matrix constraint validated');
} finally {
	await client.end();
}

assert.equal(state.index_name, STATE_INDEX_NAME, 'durable search index name');
assert.equal(state.generation, GENERATION, 'durable search generation');
assert.equal(state.generation_key, GENERATION_KEY, 'durable search generation key');
if (ALLOW_IN_PROGRESS) {
	assert.ok(['rebuilding', 'ready'].includes(state.status), 'durable search rollout status');
} else {
	assert.equal(state.status, 'ready', 'durable search rollout readiness');
	assert.ok(state.ready_at, 'durable search ready timestamp');
	assert.equal(stats.completed, expected.total, 'AI Search completed items match the enriched corpus');
}

console.info({
	event: ALLOW_IN_PROGRESS ? 'search_rollout_progress_validated' : 'search_rollout_ready_validated',
	index: instance.id,
	generation: state.generation,
	generationKey: state.generation_key,
	status: state.status,
	rebuildEpoch: Number(state.rebuild_epoch),
	itemStates: Object.fromEntries(['completed', ...TERMINAL_ITEM_STATES].map((itemState) => [itemState, stats[itemState]])),
	expected,
	rebuildingAt: state.rebuilding_at,
	readyAt: state.ready_at,
	updatedAt: state.updated_at,
	customMetadata: instance.custom_metadata.map((field) => field.field_name),
	identityInvariants,
	identityConstraintValidated: true,
});
