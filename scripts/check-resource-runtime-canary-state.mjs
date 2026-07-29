import assert from 'node:assert/strict';
import pg from 'pg';

const PHASE = process.env.CANARY_STATE_PHASE?.trim();
const STATE_INDEX_NAME = 'public-corpus';
const GENERATION = 3;
const GENERATION_KEY = 'canonical-3-kind';
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

const FIXTURES = {
	savedWeb: {
		id: 'af47bb70-b4ba-47a6-a108-60028ad794db',
		type: 'web',
		kind: 'document',
		resourcePlatform: null,
		scope: 'corpus',
		sourceId: null,
		originalLang: 'en-US',
		url: 'https://techcrunch.com/2026/06/25/netris-raises-15m-series-a-from-a16z-to-help-ai-neoclouds-go-live-faster/',
		normalizedUrl: 'https://techcrunch.com/2026/06/25/netris-raises-15m-series-a-from-a16z-to-help-ai-neoclouds-go-live-faster/',
		storageKey: null,
		fileType: null,
		relationships: {
			saveCount: 1,
			savesMd5: 'ff05549c326250e0f5989e514c0cd000',
			workspaceCount: 1,
			workspacesMd5: '00dbb57aa4ac16d4ade70e076ec7e2c9',
			collectionCount: 0,
			collectionsMd5: EMPTY_MD5,
		},
		before: {
			tagCount: 6,
			tagsMd5: '3696f2a6d635e62674d46f6f8d776ace',
			snapshotHash: '1266e59b9fca24d71ac343a67142c339a5f948db4d90b2eb977008563f0bd740',
			platformMd5: 'fcf23a0ee1be63e1c309696a0c0a6915',
			translationCount: 3,
			translationMd5: '9150e755f1686c379fe754fd73a0874a',
		},
	},
	youtubeDescription: {
		id: 'e413960f-1d87-4b9d-9c33-2ae67ea19dac',
		type: 'youtube',
		kind: 'video',
		resourcePlatform: 'youtube',
		scope: 'corpus',
		sourceId: '8d54d028-4846-4d83-8d2a-9d2fff834e58',
		url: 'https://youtube.com/watch?v=657wlbtrzG8',
		normalizedUrl: 'https://youtube.com/watch?v=657wlbtrzG8',
		storageKey: null,
		fileType: null,
		videoId: '657wlbtrzG8',
		translationCount: 2,
		translationMd5: '59f70fba2cbc657f182ee1e1e55cea4b',
		relationships: {
			saveCount: 1,
			savesMd5: '78bb24b808f44859fe16b2ef4f954b45',
			workspaceCount: 0,
			workspacesMd5: EMPTY_MD5,
			collectionCount: 0,
			collectionsMd5: EMPTY_MD5,
		},
	},
	twitterUnchanged: {
		id: '081e19f3-59af-4577-bf3f-5fdfadf5ed64',
		type: 'twitter',
		kind: 'post',
		resourcePlatform: 'twitter',
		scope: 'corpus',
		sourceId: null,
		url: 'https://x.com/theo/status/2076078865060151465',
		normalizedUrl: 'https://x.com/theo/status/2076078865060151465',
		storageKey: null,
		fileType: null,
		tagCount: 5,
		tagsMd5: '6b248c35502476789fbe072d7045cfa4',
		snapshotHash: '08a469d2c2f118d9acade1a8092b87973dfa61893787a5d02659a081eae96c51',
		translationCount: 2,
		translationMd5: '4886791de3523758e6e5bdc3c0b0fc71',
		beforePlatformMd5: '0e87c7487ff9d8265694b8f3521decbf',
		relationships: {
			saveCount: 1,
			savesMd5: 'ff05549c326250e0f5989e514c0cd000',
			workspaceCount: 1,
			workspacesMd5: '00dbb57aa4ac16d4ade70e076ec7e2c9',
			collectionCount: 0,
			collectionsMd5: EMPTY_MD5,
		},
	},
};

if (PHASE !== 'before' && PHASE !== 'after') {
	throw new Error("Set CANARY_STATE_PHASE to exactly 'before' or 'after'");
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL;
	if (!value) {
		throw new Error('Set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE or DIRECT_URL to a direct PostgreSQL connection');
	}
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

function assertIdentity(row, expected, label) {
	assert.equal(row.id, expected.id, `${label} id`);
	assert.equal(row.type, expected.type, `${label} legacy type`);
	assert.equal(row.kind, expected.kind, `${label} kind`);
	assert.equal(row.resource_platform, expected.resourcePlatform, `${label} resource platform`);
	assert.equal(row.scope, expected.scope, `${label} scope`);
	assert.equal(row.source_id, expected.sourceId, `${label} source id`);
	if (expected.originalLang !== undefined) assert.equal(row.original_lang, expected.originalLang, `${label} original language`);
	assert.equal(row.url, expected.url, `${label} URL`);
	assert.equal(row.normalized_url, expected.normalizedUrl, `${label} normalized URL`);
	assert.equal(row.storage_key, expected.storageKey, `${label} storage key`);
	assert.equal(row.file_type, expected.fileType, `${label} file type`);
	assert.equal(row.enrichment_status, 'enriched', `${label} enrichment status`);
}

function assertRelationships(row, expected, label) {
	assert.equal(row.save_count, expected.saveCount, `${label} save count`);
	assert.equal(row.saves_md5, expected.savesMd5, `${label} saves fingerprint`);
	assert.equal(row.workspace_count, expected.workspaceCount, `${label} workspace count`);
	assert.equal(row.workspaces_md5, expected.workspacesMd5, `${label} workspaces fingerprint`);
	assert.equal(row.collection_count, expected.collectionCount, `${label} collection count`);
	assert.equal(row.collections_md5, expected.collectionsMd5, `${label} collections fingerprint`);
}

const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();
let state;
let resources;
let transcriptRows;
try {
	await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
	const stateResult = await client.query(
		`SELECT index_name, generation, generation_key, status, rebuild_epoch, rebuilding_at, ready_at, updated_at
		   FROM search_index_states
		  WHERE index_name = $1`,
		[STATE_INDEX_NAME],
	);
	const resourcesResult = await client.query(
		`SELECT
		   r.id::text,
		   r.type,
		   r.kind,
		   r.resource_platform,
		   r.scope,
		   r.source_id::text,
		   r.original_lang,
		   r.url,
		   r.normalized_url,
		   r.storage_key,
		   r.file_type,
		   r.enrichment_status,
		   cardinality(r.tags) AS tag_count,
		   md5(COALESCE(array_to_string(r.tags, E'\\x1f'), '')) AS tags_md5,
		   r.platform_metadata ->> 'sourceSnapshotHash' AS snapshot_hash,
		   md5(COALESCE(r.platform_metadata::text, '')) AS platform_md5,
		   r.platform_metadata #>> '{data,videoId}' AS video_id,
		   length(COALESCE(r.platform_metadata #>> '{data,description}', '')) AS description_length,
		   (
		     SELECT COUNT(*)::int
		       FROM resource_translations rt
		      WHERE rt.resource_id = r.id
		   ) AS translation_count,
		   (
		     SELECT COUNT(*)::int
		       FROM resource_translations rt
		      WHERE rt.resource_id = r.id
		        AND rt.lang = r.original_lang
		        AND rt.source = 'original'
		        AND NULLIF(BTRIM(rt.title), '') IS NOT NULL
		        AND NULLIF(BTRIM(rt.content), '') IS NOT NULL
		   ) AS original_translation_count,
		   (
		     SELECT md5(
		       COALESCE(
		         jsonb_agg(
		           jsonb_build_object(
		             'lang', rt.lang,
		             'title', rt.title,
		             'summary', rt.summary,
		             'content', rt.content,
		             'keywords', rt.keywords,
		             'source', rt.source
		           )
		           ORDER BY rt.lang
		         )::text,
		         '[]'
		       )
		     )
		       FROM resource_translations rt
		      WHERE rt.resource_id = r.id
		   ) AS translation_md5,
		   (
		     SELECT COUNT(*)::int
		       FROM resource_saves rs
		      WHERE rs.resource_id = r.id
		   ) AS save_count,
		   (
		     SELECT md5(COALESCE(string_agg(rs.user_id, ',' ORDER BY rs.user_id), ''))
		       FROM resource_saves rs
		      WHERE rs.resource_id = r.id
		   ) AS saves_md5,
		   (
		     SELECT COUNT(*)::int
		       FROM workspace_resources wr
		      WHERE wr.resource_id = r.id
		   ) AS workspace_count,
		   (
		     SELECT md5(COALESCE(string_agg(wr.workspace_id::text, ',' ORDER BY wr.workspace_id::text), ''))
		       FROM workspace_resources wr
		      WHERE wr.resource_id = r.id
		   ) AS workspaces_md5,
		   (
		     SELECT COUNT(*)::int
		       FROM collection_resources cr
		      WHERE cr.resource_id = r.id
		   ) AS collection_count,
		   (
		     SELECT md5(COALESCE(string_agg(cr.collection_id::text, ',' ORDER BY cr.collection_id::text), ''))
		       FROM collection_resources cr
		      WHERE cr.resource_id = r.id
		   ) AS collections_md5
		 FROM resources r
		WHERE r.id = ANY($1::uuid[])
		ORDER BY r.id`,
		[Object.values(FIXTURES).map((fixture) => fixture.id)],
	);
	const transcriptResult = await client.query(
		`SELECT
		   video_id,
		   CASE
		     WHEN jsonb_typeof(transcript) = 'array' THEN jsonb_array_length(transcript)
		     ELSE NULL
		   END AS segment_count
		 FROM youtube_transcripts
		WHERE video_id = $1`,
		[FIXTURES.youtubeDescription.videoId],
	);
	await client.query('COMMIT');
	assert.equal(stateResult.rowCount, 1, 'canonical search generation row');
	[state] = stateResult.rows;
	assert.equal(resourcesResult.rowCount, Object.keys(FIXTURES).length, 'exact canary resource fixture count');
	resources = new Map(resourcesResult.rows.map((row) => [row.id, row]));
	transcriptRows = transcriptResult.rows;
} catch (error) {
	await client.query('ROLLBACK').catch(() => undefined);
	throw error;
} finally {
	await client.end();
}

assert.equal(state.index_name, STATE_INDEX_NAME, 'search generation index name');
assert.equal(state.generation, GENERATION, 'search generation');
assert.equal(state.generation_key, GENERATION_KEY, 'search generation key');
assert.equal(Number(state.rebuild_epoch), 4, 'search generation canary epoch');
assert.equal(state.status, 'ready', `${PHASE}-canary search generation status`);
assert.ok(state.ready_at, `${PHASE}-canary search generation ready timestamp`);

const savedWeb = resources.get(FIXTURES.savedWeb.id);
assert.ok(savedWeb, 'saved Web fixture');
assertIdentity(savedWeb, FIXTURES.savedWeb, 'saved Web');
assertRelationships(savedWeb, FIXTURES.savedWeb.relationships, 'saved Web');
if (PHASE === 'before') {
	assert.equal(savedWeb.tag_count, FIXTURES.savedWeb.before.tagCount, 'saved Web baseline tag count');
	assert.equal(savedWeb.tags_md5, FIXTURES.savedWeb.before.tagsMd5, 'saved Web baseline tags fingerprint');
	assert.equal(savedWeb.snapshot_hash, FIXTURES.savedWeb.before.snapshotHash, 'saved Web baseline snapshot hash');
	assert.equal(savedWeb.platform_md5, FIXTURES.savedWeb.before.platformMd5, 'saved Web baseline platform fingerprint');
	assert.equal(savedWeb.translation_count, FIXTURES.savedWeb.before.translationCount, 'saved Web baseline translation count');
	assert.equal(savedWeb.translation_md5, FIXTURES.savedWeb.before.translationMd5, 'saved Web baseline translation fingerprint');
} else {
	assert.ok(savedWeb.tag_count > 0, 'saved Web retains classification tags');
	assert.match(savedWeb.snapshot_hash ?? '', /^[a-f0-9]{64}$/, 'saved Web source snapshot hash');
}
assert.equal(savedWeb.original_translation_count, 1, 'saved Web retains one nonempty original-language Markdown row');

const youtubeDescription = resources.get(FIXTURES.youtubeDescription.id);
assert.ok(youtubeDescription, 'YouTube description fixture');
assertIdentity(youtubeDescription, FIXTURES.youtubeDescription, 'YouTube description');
assertRelationships(youtubeDescription, FIXTURES.youtubeDescription.relationships, 'YouTube description');
assert.equal(youtubeDescription.video_id, FIXTURES.youtubeDescription.videoId, 'YouTube description video id');
assert.equal(youtubeDescription.translation_count, FIXTURES.youtubeDescription.translationCount, 'YouTube description translation count');
assert.equal(youtubeDescription.translation_md5, FIXTURES.youtubeDescription.translationMd5, 'YouTube description translation fingerprint');
assert.ok(transcriptRows.length <= 1, 'YouTube description transcript row count');
if (PHASE === 'before') {
	assert.equal(youtubeDescription.description_length, 304, 'YouTube baseline description length');
	assert.equal(transcriptRows.length, 0, 'YouTube baseline transcript is absent');
} else {
	assert.ok(youtubeDescription.description_length > 0, 'YouTube description remains nonempty');
	assert.match(youtubeDescription.snapshot_hash ?? '', /^[a-f0-9]{64}$/, 'YouTube source snapshot hash');
	assert.equal(transcriptRows.length, 1, 'YouTube description fallback transcript row');
	assert.equal(transcriptRows[0].video_id, FIXTURES.youtubeDescription.videoId, 'YouTube transcript video id');
	assert.equal(transcriptRows[0].segment_count, 0, 'YouTube description fallback transcript segment count');
}

const twitterUnchanged = resources.get(FIXTURES.twitterUnchanged.id);
assert.ok(twitterUnchanged, 'Twitter unchanged fixture');
assertIdentity(twitterUnchanged, FIXTURES.twitterUnchanged, 'Twitter unchanged');
assertRelationships(twitterUnchanged, FIXTURES.twitterUnchanged.relationships, 'Twitter unchanged');
assert.equal(twitterUnchanged.tag_count, FIXTURES.twitterUnchanged.tagCount, 'Twitter unchanged tag count');
assert.equal(twitterUnchanged.tags_md5, FIXTURES.twitterUnchanged.tagsMd5, 'Twitter unchanged tags fingerprint');
assert.equal(twitterUnchanged.snapshot_hash, FIXTURES.twitterUnchanged.snapshotHash, 'Twitter unchanged snapshot hash');
assert.equal(twitterUnchanged.translation_count, FIXTURES.twitterUnchanged.translationCount, 'Twitter unchanged translation count');
assert.equal(twitterUnchanged.translation_md5, FIXTURES.twitterUnchanged.translationMd5, 'Twitter unchanged translation fingerprint');
if (PHASE === 'before') {
	assert.equal(twitterUnchanged.platform_md5, FIXTURES.twitterUnchanged.beforePlatformMd5, 'Twitter baseline platform fingerprint');
}

console.info(
	JSON.stringify({
		event: 'resource_runtime_canary_state_validated',
		phase: PHASE,
		searchGeneration: {
			generation: state.generation,
			generationKey: state.generation_key,
			status: state.status,
			rebuildEpoch: Number(state.rebuild_epoch),
			readyAt: state.ready_at,
		},
		fixtures: {
			savedWeb: {
				id: savedWeb.id,
				identity: `${savedWeb.type}/${savedWeb.kind}/${savedWeb.resource_platform ?? 'null'}`,
				snapshotHash: savedWeb.snapshot_hash,
				translationCount: savedWeb.translation_count,
				originalTranslationCount: savedWeb.original_translation_count,
				translationMd5: savedWeb.translation_md5,
				saves: savedWeb.save_count,
				workspaces: savedWeb.workspace_count,
				collections: savedWeb.collection_count,
			},
			youtubeDescription: {
				id: youtubeDescription.id,
				identity: `${youtubeDescription.type}/${youtubeDescription.kind}/${youtubeDescription.resource_platform}`,
				descriptionLength: youtubeDescription.description_length,
				translationCount: youtubeDescription.translation_count,
				translationMd5: youtubeDescription.translation_md5,
				transcript: transcriptRows.length === 0 ? 'absent' : `segments:${transcriptRows[0].segment_count}`,
				saves: youtubeDescription.save_count,
				workspaces: youtubeDescription.workspace_count,
				collections: youtubeDescription.collection_count,
			},
			twitterUnchanged: {
				id: twitterUnchanged.id,
				identity: `${twitterUnchanged.type}/${twitterUnchanged.kind}/${twitterUnchanged.resource_platform}`,
				snapshotHash: twitterUnchanged.snapshot_hash,
				tagsMd5: twitterUnchanged.tags_md5,
				translationCount: twitterUnchanged.translation_count,
				translationMd5: twitterUnchanged.translation_md5,
				saves: twitterUnchanged.save_count,
				workspaces: twitterUnchanged.workspace_count,
				collections: twitterUnchanged.collection_count,
			},
		},
	}),
);
