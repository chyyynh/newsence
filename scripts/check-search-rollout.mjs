import assert from 'node:assert/strict';
import pg from 'pg';

const INDEX_NAME = 'newsence-corpus-v6';
const STATE_INDEX_NAME = 'public-corpus-v6';
const GENERATION = 5;
const GENERATION_KEY = 'canonical-5-blog-forum-kind';
const ALLOW_IN_PROGRESS = process.argv.includes('--allow-in-progress');
const CONTENT_IDENTITIES = [
	{ kind: 'blog', resourcePlatform: null },
	{ kind: 'forum', resourcePlatform: 'hackernews' },
	{ kind: 'post', resourcePlatform: 'twitter' },
	{ kind: 'video', resourcePlatform: 'youtube' },
	{ kind: 'paper', resourcePlatform: null },
	{ kind: 'paper', resourcePlatform: 'hackernews' },
];
const NULL_RESOURCE_PLATFORM_METADATA = 'none';
const EXPECTED_CUSTOM_METADATA = [
	{ field_name: 'effective_at', data_type: 'datetime' },
	{ field_name: 'source_id', data_type: 'text' },
	{ field_name: 'category', data_type: 'text' },
	{ field_name: 'kind', data_type: 'text' },
	{ field_name: 'resource_platform', data_type: 'text' },
];
const NON_COMPLETED_ITEM_STATES = ['queued', 'running', 'error', 'skipped', 'outdated'];

function identityKey(kind, resourcePlatform) {
	return `${kind}/${resourcePlatform ?? NULL_RESOURCE_PLATFORM_METADATA}`;
}

function emptyIdentityCounts() {
	return Object.fromEntries(CONTENT_IDENTITIES.map(({ kind, resourcePlatform }) => [identityKey(kind, resourcePlatform), 0]));
}

function aiSearchApiCredentials() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const apiToken = process.env.CLOUDFLARE_AISEARCH_API_TOKEN?.trim();
	assert.match(accountId ?? '', /^[0-9a-f]{32}$/, 'Set CLOUDFLARE_ACCOUNT_ID to the Cloudflare account id');
	assert.ok(apiToken, 'Set CLOUDFLARE_AISEARCH_API_TOKEN to a dedicated AI Search API token');
	return { accountId, apiToken };
}

function retryDelay(response, attempt) {
	const seconds = Number(response.headers.get('retry-after'));
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 20_000) : Math.min(500 * 2 ** attempt, 5000);
}

async function aiSearchApi(pathname, searchParams, label, attempt = 0) {
	const { accountId, apiToken } = aiSearchApiCredentials();
	const endpoint = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/instances/${INDEX_NAME}${pathname}`);
	for (const [key, value] of Object.entries(searchParams)) endpoint.searchParams.set(key, value);
	const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiToken}` } });
	if (response.status === 429 && attempt < 6) {
		const delay = retryDelay(response, attempt);
		await response.text();
		await new Promise((resolve) => setTimeout(resolve, delay));
		return aiSearchApi(pathname, searchParams, label, attempt + 1);
	}
	const payload = await response.json();
	assert.equal(response.ok, true, `AI Search ${label} HTTP ${response.status}`);
	assert.equal(payload.success, true, `AI Search ${label} API`);
	return payload;
}

async function listAiSearchItemCount(metadataFilter, label) {
	const payload = await aiSearchApi(
		'/items',
		{
			metadata_filter: JSON.stringify(metadataFilter),
			page: '1',
			per_page: '1',
			source: 'builtin',
		},
		`${label} item listing`,
	);
	assert.ok(Array.isArray(payload.result), `AI Search ${label} item listing result`);
	const totalCount = payload.result_info?.total_count;
	assert.ok(Number.isSafeInteger(totalCount) && totalCount >= 0, `AI Search ${label} item listing total_count`);
	return totalCount;
}

async function loadIndexedIdentityCounts() {
	const folderFilter = { folder: 'resources/' };
	const total = await listAiSearchItemCount(folderFilter, 'owned');
	const byIdentity = emptyIdentityCounts();
	// Keep the seven REST probes serialized so the operator checker works within
	// conservative connection and rate limits, matching the Worker readiness path.
	for (const { kind, resourcePlatform } of CONTENT_IDENTITIES) {
		const platform = resourcePlatform ?? NULL_RESOURCE_PLATFORM_METADATA;
		byIdentity[identityKey(kind, resourcePlatform)] = await listAiSearchItemCount(
			{
				...folderFilter,
				kind,
				resource_platform: platform,
			},
			`${kind}/${platform}`,
		);
	}
	return { total, byIdentity };
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	if (!value) {
		throw new Error(
			'Set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE, DIRECT_URL, or DATABASE_URL before checking rollout state',
		);
	}
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

const instance = (await aiSearchApi('', {}, 'instance read')).result;
assert.equal(instance.id, INDEX_NAME, 'AI Search instance');
assert.equal(instance.engine_version, 3, 'AI Search provider engine generation');
assert.equal(instance.enable, true, 'AI Search enabled');
assert.equal(instance.paused, false, 'AI Search paused');
assert.equal(instance.index_method?.vector, true, 'AI Search vector index');
assert.equal(instance.index_method?.keyword, true, 'AI Search keyword index');
assert.equal(instance.fusion_method, 'rrf', 'AI Search fusion method');
assert.equal(instance.indexing_options?.keyword_tokenizer, 'trigram', 'AI Search keyword tokenizer');
assert.deepEqual(instance.custom_metadata, EXPECTED_CUSTOM_METADATA, 'AI Search custom metadata contract');

const stats = (await aiSearchApi('/stats', {}, 'instance stats')).result;
assert.equal(typeof stats.completed, 'number', 'AI Search completed count');
for (const state of NON_COMPLETED_ITEM_STATES) {
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
		`SELECT kind, resource_platform, COUNT(*)::int AS count
		   FROM resources
		  WHERE scope = 'corpus'
		    AND enrichment_status = 'enriched'
		    AND (
		      (kind = 'blog' AND resource_platform IS NULL)
		      OR (kind = 'forum' AND resource_platform = 'hackernews')
		      OR (kind = 'post' AND resource_platform = 'twitter')
		      OR (kind = 'video' AND resource_platform = 'youtube')
		      OR (kind = 'paper' AND (resource_platform IS NULL OR resource_platform = 'hackernews'))
		    )
		  GROUP BY kind, resource_platform
		  ORDER BY kind, resource_platform`,
	);
	const invariantResult = await client.query(
		`SELECT
		   COUNT(*) FILTER (WHERE kind IS NULL)::int AS null_kind,
		   COUNT(*) FILTER (
		     WHERE kind NOT IN ('blog', 'forum', 'post', 'video', 'paper', 'image', 'file')
		   )::int AS invalid_kind,
		   COUNT(*) FILTER (
		     WHERE resource_platform IS NOT NULL
		       AND resource_platform NOT IN ('hackernews', 'twitter', 'youtube')
		   )::int AS invalid_platform,
		   COUNT(*) FILTER (
		     WHERE NOT ((
		       (kind = 'blog' AND resource_platform IS NULL)
		       OR (kind = 'forum' AND resource_platform = 'hackernews')
		       OR (kind = 'post' AND resource_platform = 'twitter')
		       OR (kind = 'video' AND resource_platform = 'youtube')
		       OR (kind = 'paper' AND resource_platform IS NULL)
		       OR (kind = 'paper' AND resource_platform = 'hackernews')
		       OR (kind = 'image' AND resource_platform IS NULL)
		       OR (kind = 'file' AND resource_platform IS NULL)
		     ) IS TRUE)
		   )::int AS invalid_matrix
		 FROM resources`,
	);
	const constraintResult = await client.query(
		`SELECT convalidated
		   FROM pg_constraint
		  WHERE conrelid = 'resources'::regclass
		    AND conname = 'resources_kind_platform_check'`,
	);

	assert.equal(stateResult.rowCount, 1, 'durable search generation row');
	[state] = stateResult.rows;
	const byIdentity = emptyIdentityCounts();
	for (const row of expectedResult.rows) {
		const key = identityKey(row.kind, row.resource_platform);
		assert.ok(Object.hasOwn(byIdentity, key), `valid content identity ${key}`);
		assert.equal(typeof row.count, 'number', `expected ${key} count`);
		byIdentity[key] = row.count;
	}
	expected = {
		total: Object.values(byIdentity).reduce((total, count) => total + count, 0),
		byIdentity,
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

const indexed = await loadIndexedIdentityCounts();

assert.equal(state.index_name, STATE_INDEX_NAME, 'durable search state index name');
assert.equal(state.generation, GENERATION, 'durable search generation');
assert.equal(state.generation_key, GENERATION_KEY, 'durable search generation key');
if (ALLOW_IN_PROGRESS) {
	assert.ok(['rebuilding', 'ready'].includes(state.status), 'durable search rollout status');
} else {
	assert.equal(state.status, 'ready', 'durable search rollout readiness');
	assert.ok(state.ready_at, 'durable search ready timestamp');
	assert.equal(stats.completed, expected.total, 'completed items match the enriched corpus');
	assert.equal(indexed.total, expected.total, 'indexed owned items match the enriched corpus');
	assert.deepEqual(indexed.byIdentity, expected.byIdentity, 'all six indexed identity counts match the enriched corpus');
}

console.info({
	event: ALLOW_IN_PROGRESS ? 'search_rollout_progress_validated' : 'search_rollout_ready_validated',
	index: instance.id,
	generation: state.generation,
	generationKey: state.generation_key,
	status: state.status,
	rebuildEpoch: Number(state.rebuild_epoch),
	itemStates: Object.fromEntries(['completed', ...NON_COMPLETED_ITEM_STATES].map((itemState) => [itemState, stats[itemState]])),
	expected,
	indexed,
	rebuildingAt: state.rebuilding_at,
	readyAt: state.ready_at,
	updatedAt: state.updated_at,
	customMetadata: instance.custom_metadata.map((field) => field.field_name),
	identityInvariants,
	identityConstraintValidated: true,
});
