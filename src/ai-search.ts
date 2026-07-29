import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
	CONTENT_RESOURCE_KINDS,
	type ContentResourceKind,
	parseResourceIdentity,
	type ResourceCategory,
	type ResourceKind,
	type ResourcePlatform,
} from '@core-shared/resource-types';
import { type CoreDb, isValidUuid, queryRows, textArraySql, uuidArraySql, withCoreDb } from '@db/client';
import { contentResourceIdentitySql, resourceDisplaySourceSql } from '@db/resource-identity-sql';
import { assertResourceWritesEnabled } from '@db/resource-write-guard';
import { sql } from 'drizzle-orm';
import terminalRepair251Checkpoint from '../search-terminal-repair-251.json';
import { enqueueOrRestartWorkflow } from './workflow-control';

// Cloudflare AI Search allows at most five custom metadata fields per instance.
// https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/
const AI_SEARCH_CUSTOM_METADATA_FIELD_LIMIT = 5;
const NULL_RESOURCE_PLATFORM_METADATA = 'none';
const CANONICAL_CUSTOM_METADATA = [
	{ field_name: 'effective_at', data_type: 'datetime' },
	{ field_name: 'source_id', data_type: 'text' },
	{ field_name: 'category', data_type: 'text' },
	{ field_name: 'kind', data_type: 'text' },
	{ field_name: 'resource_platform', data_type: 'text' },
] as const satisfies NonNullable<AiSearchConfig['custom_metadata']>;
const CANONICAL_CONTENT_IDENTITIES = [
	{ kind: 'document', resourcePlatform: null },
	{ kind: 'document', resourcePlatform: 'hackernews' },
	{ kind: 'post', resourcePlatform: 'twitter' },
	{ kind: 'video', resourcePlatform: 'youtube' },
	{ kind: 'paper', resourcePlatform: null },
	{ kind: 'paper', resourcePlatform: 'hackernews' },
] as const satisfies readonly {
	kind: ContentResourceKind;
	resourcePlatform: ResourcePlatform;
}[];
if (CANONICAL_CUSTOM_METADATA.length > AI_SEARCH_CUSTOM_METADATA_FIELD_LIMIT) {
	throw new Error(`AI Search metadata exceeds the ${AI_SEARCH_CUSTOM_METADATA_FIELD_LIMIT}-field limit`);
}
const ITEM_PREFIX = 'resources/';
const ITEM_SUFFIX = '.md';
const ORIGINAL_CONTENT_MAX_CHARS = 8_000;
const TRANSLATED_CONTENT_MAX_CHARS = 4_000;
const MAX_RESULTS = 50;
const INDEX_TRANSLATION_LANGS = ['en', 'zh-Hant'] as const;

type CorpusTranslationRow = {
	lang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	keywords: string[] | null;
};

type CorpusDocument = {
	id: string;
	source_id: string | null;
	kind: string;
	resource_platform: string | null;
	platform_metadata: unknown;
	original_lang: string;
	effective_at: Date | string | null;
	tags: string[] | null;
	category: string | null;
	source: string | null;
	translations: CorpusTranslationRow[];
};

type AiSearchRank = { id: string; score: number };
type CorpusSearchProfile = 'discovery' | 'related';

type CorpusSearchOptions = {
	categories?: readonly ResourceCategory[];
	effectiveAfter?: Date | null;
	effectiveBefore?: Date | null;
	kinds?: readonly ContentResourceKind[];
	profile?: CorpusSearchProfile;
	resourcePlatforms?: readonly ResourcePlatform[];
	sourceIds?: readonly string[];
};

function itemKey(id: string): string {
	return `${ITEM_PREFIX}${id}${ITEM_SUFFIX}`;
}

function idFromItemKey(key: string): string | null {
	if (!key.startsWith(ITEM_PREFIX) || !key.endsWith(ITEM_SUFFIX)) return null;
	const id = key.slice(ITEM_PREFIX.length, -ITEM_SUFFIX.length);
	return isValidUuid(id) ? id : null;
}

function markdownSection(label: string, value: string | null | undefined): string {
	return value?.trim() ? `\n## ${label}\n\n${value.trim()}\n` : '';
}

function requiredDocumentText(value: string | null, field: string, resourceId: string): string {
	const text = value?.trim();
	if (!text) throw new Error(`AI Search document ${resourceId} is missing ${field}`);
	return text;
}

function documentEffectiveAt(row: CorpusDocument): string | undefined {
	if (row.effective_at === null) return undefined;
	const date = new Date(row.effective_at);
	if (Number.isNaN(date.getTime())) throw new Error(`AI Search document ${row.id} has invalid effective date`);
	return date.toISOString();
}

function corpusDocumentIdentity(document: CorpusDocument): {
	kind: ContentResourceKind;
	resourcePlatform: ResourcePlatform;
} {
	const identity = parseResourceIdentity(document.kind, document.resource_platform);
	if (!identity || !(CONTENT_RESOURCE_KINDS as readonly ResourceKind[]).includes(identity.kind)) {
		throw new Error(
			`AI Search document ${document.id} has invalid persisted identity ${String(document.kind)} / ${String(document.resource_platform)}`,
		);
	}
	return {
		kind: identity.kind as ContentResourceKind,
		resourcePlatform: identity.resourcePlatform,
	};
}

function serializeTranslation(translation: CorpusTranslationRow, originalLang: string): string {
	const contentLimit = translation.lang === originalLang ? ORIGINAL_CONTENT_MAX_CHARS : TRANSLATED_CONTENT_MAX_CHARS;
	return [
		`## ${translation.lang}`,
		translation.title?.trim() ? `Title: ${translation.title.trim()}` : '',
		translation.keywords?.length ? `Keywords: ${translation.keywords.join(', ')}` : '',
		markdownSection('Summary', translation.summary),
		markdownSection('Content', translation.content?.slice(0, contentLimit)),
	]
		.filter(Boolean)
		.join('\n\n');
}

function serializeDocument(row: CorpusDocument): string {
	const original = row.translations.find((translation) => translation.lang === row.original_lang);
	if (!original) throw new Error(`AI Search document ${row.id} is missing its ${row.original_lang} translation`);
	const title = requiredDocumentText(original.title, 'title', row.id);
	const source = requiredDocumentText(row.source, 'source', row.id);
	return [
		`# ${title}`,
		source,
		row.tags?.length ? `Tags: ${row.tags.join(', ')}` : '',
		...row.translations.map((translation) => serializeTranslation(translation, row.original_lang)),
	]
		.filter(Boolean)
		.join('\n\n');
}

async function loadCorpusDocuments(db: CoreDb, resourceIds: readonly string[]): Promise<CorpusDocument[]> {
	if (!resourceIds.length) return [];
	return queryRows<CorpusDocument>(
		db,
		sql`
				SELECT r.id::text,
				       r.source_id::text,
				       r.kind,
				       r.resource_platform,
				       r.platform_metadata,
				       r.original_lang,
				       COALESCE(r.published_date, r.scraped_date, r.created_at) AS effective_at,
				       r.tags,
				       r.category,
				       ${resourceDisplaySourceSql({
									kind: sql`r.kind`,
									monitoredSourceName: sql`s.name`,
									platformMetadata: sql`r.platform_metadata`,
									resourcePlatform: sql`r.resource_platform`,
								})} AS source,
				       COALESCE((
				         SELECT jsonb_agg(
				           jsonb_build_object(
				             'lang', rt.lang,
				             'title', rt.title,
				             'summary', rt.summary,
				             'content', rt.content,
				             'keywords', rt.keywords
				           )
				           ORDER BY (rt.lang = r.original_lang) DESC, rt.lang
				         )
				         FROM resource_translations rt
				         WHERE rt.resource_id = r.id
				           AND (rt.lang = r.original_lang OR rt.lang = ANY(${textArraySql(INDEX_TRANSLATION_LANGS)}))
				       ), '[]'::jsonb) AS translations
				FROM resources r
				LEFT JOIN sources s ON s.id = r.source_id
				WHERE r.id = ANY(${uuidArraySql(resourceIds)})
					  AND r.scope = 'corpus'
					  AND r.enrichment_status = 'enriched'
					  AND ${contentResourceIdentitySql({
							kind: sql`r.kind`,
							resourcePlatform: sql`r.resource_platform`,
						})}
		`,
	);
}

async function loadCorpusDocument(db: CoreDb, resourceId: string): Promise<CorpusDocument | null> {
	return (await loadCorpusDocuments(db, [resourceId]))[0] ?? null;
}

function corpusItemMetadata(document: CorpusDocument): Record<string, unknown> {
	const effectiveAt = documentEffectiveAt(document);
	const identity = corpusDocumentIdentity(document);
	return {
		...(effectiveAt ? { effective_at: effectiveAt } : {}),
		...(document.source_id ? { source_id: document.source_id } : {}),
		...(document.category ? { category: document.category } : {}),
		kind: identity.kind,
		resource_platform: identity.resourcePlatform ?? NULL_RESOURCE_PLATFORM_METADATA,
	};
}

async function uploadCorpusDocumentTo(
	index: AiSearchInstance,
	document: CorpusDocument,
	metadata: Record<string, unknown>,
): Promise<AiSearchItemInfo | null> {
	const startedAt = Date.now();
	const result: AiSearchItemInfo | null = await index.items.upload(itemKey(document.id), serializeDocument(document), {
		metadata,
	});
	console.info({
		tag: 'AI_SEARCH',
		msg: 'Corpus item queued',
		resource_id: document.id,
		item_id: result?.id ?? null,
		latency_ms: Date.now() - startedAt,
	});
	return result;
}

function uploadCorpusDocument(env: CoreEnv, document: CorpusDocument): Promise<AiSearchItemInfo | null> {
	return uploadCorpusDocumentTo(env.AI_SEARCH, document, corpusItemMetadata(document));
}

export async function syncCorpusItem(env: CoreEnv, resourceId: string): Promise<'uploaded' | 'deleted' | 'skipped'> {
	await assertResourceWritesEnabled(env, 'AI Search corpus sync');
	if (!isValidUuid(resourceId)) return 'skipped';
	const document = await withCoreDb(env, (db) => loadCorpusDocument(db, resourceId));
	if (!document) {
		await deleteCorpusItem(env, resourceId);
		return 'deleted';
	}
	await uploadCorpusDocument(env, document);
	return 'uploaded';
}

async function deleteCorpusItemFrom(index: AiSearchInstance, resourceId: string): Promise<boolean> {
	const key = itemKey(resourceId);
	// Search by the bare id, not the full key: a value containing `/` is parsed as
	// a folder metadata filter and rejected with 7001 "metadata filter pattern
	// exceeds maximum length", so passing `resources/<id>.md` failed every call.
	// The REST API grew an exact-`key` parameter, but the Workers binding type has
	// no such field yet — the exact-match filter below covers the difference.
	const listed = await index.items.list({ search: resourceId, source: 'builtin', per_page: 1 });
	const matches = listed.result.filter((item) => item.key === key && item.source_id === 'builtin');
	await Promise.all(matches.map((item) => index.items.delete(item.id)));
	if (matches.length) {
		console.info({
			tag: 'AI_SEARCH',
			msg: 'Corpus item deleted',
			resource_id: resourceId,
			count: matches.length,
		});
	}
	return matches.length > 0;
}

export async function deleteCorpusItem(env: CoreEnv, resourceId: string): Promise<boolean> {
	await assertResourceWritesEnabled(env, 'AI Search corpus delete');
	return deleteCorpusItemFrom(env.AI_SEARCH, resourceId);
}

function searchFilters(options: CorpusSearchOptions): VectorizeVectorMetadataFilter | null | undefined {
	if (
		options.sourceIds?.length === 0 ||
		options.categories?.length === 0 ||
		options.kinds?.length === 0 ||
		options.resourcePlatforms?.length === 0
	) {
		return null;
	}
	const filters: VectorizeVectorMetadataFilter = {};
	if (options.sourceIds?.length) {
		filters.source_id = { $in: [...options.sourceIds] };
	}
	if (options.categories?.length) filters.category = { $in: [...options.categories] };
	if (options.kinds?.length) filters.kind = { $in: [...options.kinds] };
	if (options.resourcePlatforms?.length) {
		filters.resource_platform = { $in: options.resourcePlatforms.map(resourcePlatformMetadata) };
	}
	if (options.effectiveAfter || options.effectiveBefore) {
		filters.effective_at = {
			...(options.effectiveAfter ? { $gte: options.effectiveAfter.toISOString() } : {}),
			...(options.effectiveBefore ? { $lte: options.effectiveBefore.toISOString() } : {}),
		};
	}
	return Object.keys(filters).length ? filters : undefined;
}

export async function searchCorpusRanks(env: CoreEnv, query: string, options: CorpusSearchOptions = {}): Promise<AiSearchRank[]> {
	const profile = options.profile ?? 'discovery';
	const retrievalType = profile === 'related' ? 'vector' : 'hybrid';
	const filters = searchFilters(options);
	if (filters === null) return [];
	if (options.kinds?.length) {
		console.info({
			tag: 'AI_SEARCH',
			msg: 'Corpus search metadata contract selected',
			metadata_contract: 'canonical-kind-platform',
			requested_kind_count: options.kinds.length,
			requested_platform_count: options.resourcePlatforms?.length ?? 0,
		});
	}
	const response = await env.AI_SEARCH.search({
		query,
		ai_search_options: {
			query_rewrite: { enabled: false },
			reranking: { enabled: false },
			retrieval: {
				retrieval_type: retrievalType,
				...(retrievalType === 'hybrid' ? { fusion_method: 'rrf' as const } : {}),
				keyword_match_mode: 'or',
				max_num_results: MAX_RESULTS,
				metadata_only: true,
				return_on_failure: false,
				...(profile === 'related' ? {} : { boost_by: [{ field: 'effective_at', direction: 'desc' as const }] }),
				...(filters ? { filters } : {}),
			},
		},
	});
	const ranks = new Map<string, AiSearchRank>();
	for (const [index, chunk] of response.chunks.entries()) {
		const id = idFromItemKey(chunk.item.key);
		if (!id || ranks.has(id)) continue;
		// Consumers hydrate rows in PostgreSQL, so return a unique order-preserving
		// score instead of the tied scores commonly produced by RRF.
		ranks.set(id, { id, score: response.chunks.length - index });
	}
	return [...ranks.values()];
}

type SearchIndexRebuildPayload = Record<string, never>;

const SEARCH_INDEX_NAME = 'public-corpus-v6';
const SEARCH_INDEX_GENERATION = { key: 'canonical-4-kind-platform', ordinal: 4 } as const;
// The physical Workflow resource is generation-specific. This runner id is
// stable only inside that isolated resource; it is not itself a replay boundary.
const SEARCH_INDEX_REBUILD_INSTANCE_ID = `search-index-rebuild-${SEARCH_INDEX_GENERATION.key}-canonical-v1`;
const REINDEX_PAGE_SIZE = 50;
// Workers allow at most six simultaneous outgoing connections per invocation.
// Stay below that ceiling instead of relying on the runtime to queue the
// seventh AI Search binding call inside one durable step.
const REINDEX_AI_SEARCH_CONCURRENCY = 5;
const REINDEX_MAX_PRUNE_PASSES = 3;
// Batch prune pages and combine corpus reads/uploads below so the current full
// rebuild stays under the 1,024-step Workflow limit on Workers Free.
const REINDEX_PRUNE_PAGES_PER_STEP = 10;
const REINDEX_REPAIR_LIST_PAGE_SIZE = 50;
const REINDEX_READY_POLL_ATTEMPTS = 36;
const REINDEX_READY_POLL_INTERVAL = '10 minutes';
const STEP_RETRIES = { limit: 5, delay: '10 seconds', backoff: 'exponential' } as const;
const SHORT_STEP_OPTIONS = { retries: STEP_RETRIES, timeout: '60 seconds' } as const;
const BATCH_STEP_OPTIONS = { retries: STEP_RETRIES, timeout: '300 seconds' } as const;
const UTC_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

type SearchIndexRebuildLease = {
	rebuildEpoch: string;
	startedAt: string;
};

type SearchIndexRebuildingRow = {
	rebuild_epoch: string;
	started_at: string;
};

type SearchIndexTerminalRepair251Checkpoint = {
	aiSearchInstanceName: string;
	generation: number;
	generationKey: string;
	initialRepairCounts: {
		error: number;
		outdated: number;
		total: number;
	};
	initialRepairTargetDigest: string;
	maxRepairRounds: number;
	repairInstanceId: string;
	repairWorkerName: string;
	repairWorkflowName: string;
	sourceErrorName: string;
	sourceErrorPrefix: string;
	sourceInstanceId: string;
	sourceRebuildEpoch: number;
	sourceWorkflowName: string;
};

type SearchIndexTerminalRepair251Env = CoreEnv & {
	PHASE1_SEARCH_REBUILD_SOURCE: Workflow<Record<string, unknown>>;
};

function searchIndexTerminalRepair251Checkpoint(): SearchIndexTerminalRepair251Checkpoint {
	const checkpoint = terminalRepair251Checkpoint as SearchIndexTerminalRepair251Checkpoint;
	if (checkpoint.generation !== SEARCH_INDEX_GENERATION.ordinal || checkpoint.generationKey !== SEARCH_INDEX_GENERATION.key) {
		throw new Error(
			`AI Search terminal repair checkpoint generation ${checkpoint.generation}/${checkpoint.generationKey} does not match ${SEARCH_INDEX_GENERATION.ordinal}/${SEARCH_INDEX_GENERATION.key}`,
		);
	}
	if (
		!checkpoint.aiSearchInstanceName.trim() ||
		!checkpoint.repairWorkerName.trim() ||
		!checkpoint.repairWorkflowName.trim() ||
		!checkpoint.repairInstanceId.trim() ||
		!checkpoint.sourceWorkflowName.trim() ||
		!checkpoint.sourceInstanceId.trim()
	) {
		throw new Error('AI Search terminal repair checkpoint identity is empty');
	}
	if (!Number.isSafeInteger(checkpoint.sourceRebuildEpoch) || checkpoint.sourceRebuildEpoch < 0) {
		throw new Error('AI Search terminal repair checkpoint source epoch must be a non-negative safe integer');
	}
	if (!checkpoint.sourceErrorName.trim() || !checkpoint.sourceErrorPrefix.trim()) {
		throw new Error('AI Search terminal repair checkpoint source error fence is empty');
	}
	if (!/^[0-9a-f]{64}$/.test(checkpoint.initialRepairTargetDigest)) {
		throw new Error('AI Search terminal repair checkpoint target digest must be lowercase SHA-256 hex');
	}
	const { error, outdated, total } = checkpoint.initialRepairCounts;
	if (
		![error, outdated, total, checkpoint.maxRepairRounds].every((value) => Number.isSafeInteger(value) && value >= 0) ||
		total !== error + outdated ||
		checkpoint.maxRepairRounds <= 0
	) {
		throw new Error('AI Search terminal repair checkpoint counts or repair bound are invalid');
	}
	return checkpoint;
}

async function verifySearchIndexTerminalRepair251Binding(
	env: CoreEnv,
	checkpoint: SearchIndexTerminalRepair251Checkpoint,
): Promise<{ configReady: true; id: string; paused: false }> {
	const info = await env.AI_SEARCH.info();
	if (info.id !== checkpoint.aiSearchInstanceName) {
		throw new Error(`AI Search terminal repair binding ${info.id} does not match ${checkpoint.aiSearchInstanceName}`);
	}
	if (info.paused !== false || !canonicalSearchInstanceConfigMatches(info)) {
		throw new Error(`AI Search terminal repair binding ${info.id} is paused or has the wrong canonical config`);
	}
	return { configReady: true, id: info.id, paused: false };
}

async function writeSearchIndexRebuildingState(env: CoreEnv, advanceEpoch: boolean): Promise<SearchIndexRebuildLease> {
	const epochIncrement = advanceEpoch ? 1 : 0;
	const [row] = await withCoreDb(env, (db) =>
		queryRows<SearchIndexRebuildingRow>(
			db,
			sql`
				INSERT INTO search_index_states (
				  index_name,
				  generation,
				  generation_key,
				  status,
				  rebuild_epoch,
				  rebuilding_at,
				  ready_at,
				  updated_at
				)
				VALUES (
				  ${SEARCH_INDEX_NAME},
				  ${SEARCH_INDEX_GENERATION.ordinal},
				  ${SEARCH_INDEX_GENERATION.key},
				  'rebuilding',
				  ${epochIncrement},
				  clock_timestamp(),
				  NULL,
				  clock_timestamp()
				)
				ON CONFLICT (index_name) DO UPDATE SET
				  generation = EXCLUDED.generation,
				  generation_key = EXCLUDED.generation_key,
				  status = 'rebuilding',
				  rebuild_epoch = search_index_states.rebuild_epoch + ${epochIncrement},
				  rebuilding_at = clock_timestamp(),
				  ready_at = NULL,
				  updated_at = clock_timestamp()
				WHERE search_index_states.generation < EXCLUDED.generation
				   OR (
				     search_index_states.generation = EXCLUDED.generation
				     AND search_index_states.generation_key = EXCLUDED.generation_key
				   )
				RETURNING
				  rebuild_epoch::text,
				  to_char(rebuilding_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS started_at
			`,
		),
	);
	if (!row) {
		throw new Error(
			`AI Search generation ${SEARCH_INDEX_GENERATION.ordinal}/${SEARCH_INDEX_GENERATION.key} is superseded or conflicts with durable state`,
		);
	}
	return { rebuildEpoch: row.rebuild_epoch, startedAt: row.started_at };
}

async function beginSearchIndexRebuild(env: CoreEnv): Promise<SearchIndexRebuildLease> {
	await assertResourceWritesEnabled(env, 'begin AI Search canonical rebuild');
	return writeSearchIndexRebuildingState(env, true);
}

async function claimSearchIndexTerminalRepair251(
	env: CoreEnv,
	checkpoint: SearchIndexTerminalRepair251Checkpoint,
	claimStartedAt: string,
): Promise<SearchIndexRebuildLease & { sourceRebuildEpoch: string }> {
	await assertResourceWritesEnabled(env, 'claim AI Search terminal repair #251');
	const sourceRebuildEpoch = String(checkpoint.sourceRebuildEpoch);
	const expectedRebuildEpoch = String(checkpoint.sourceRebuildEpoch + 1);
	const [row] = await withCoreDb(env, (db) =>
		queryRows<SearchIndexRebuildingRow>(
			db,
			sql`
				WITH claimed AS (
				  UPDATE search_index_states
				  SET status = 'rebuilding',
				      rebuild_epoch = rebuild_epoch + 1,
				      rebuilding_at = ${claimStartedAt}::timestamptz,
				      ready_at = NULL,
				      updated_at = ${claimStartedAt}::timestamptz
				  WHERE index_name = ${SEARCH_INDEX_NAME}
				    AND generation = ${checkpoint.generation}
				    AND generation_key = ${checkpoint.generationKey}
				    AND status = 'rebuilding'
				    AND rebuild_epoch = ${sourceRebuildEpoch}::bigint
				    AND ready_at IS NULL
				  RETURNING rebuild_epoch, rebuilding_at
				)
				SELECT
				  rebuild_epoch::text,
				  to_char(rebuilding_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS started_at
				FROM claimed
				UNION ALL
				SELECT
				  rebuild_epoch::text,
				  to_char(rebuilding_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS started_at
				FROM search_index_states
				WHERE index_name = ${SEARCH_INDEX_NAME}
				  AND generation = ${checkpoint.generation}
				  AND generation_key = ${checkpoint.generationKey}
				  AND status = 'rebuilding'
				  AND rebuild_epoch = ${expectedRebuildEpoch}::bigint
				  AND rebuilding_at = ${claimStartedAt}::timestamptz
				  AND ready_at IS NULL
				  AND NOT EXISTS (SELECT 1 FROM claimed)
				LIMIT 1
			`,
		),
	);
	if (!row || row.rebuild_epoch !== expectedRebuildEpoch) {
		throw new Error(`AI Search terminal repair could not claim ${checkpoint.generation}/${checkpoint.generationKey}/${sourceRebuildEpoch}`);
	}
	return {
		sourceRebuildEpoch,
		rebuildEpoch: row.rebuild_epoch,
		startedAt: row.started_at,
	};
}

async function assertSearchIndexRebuildLease(env: CoreEnv, lease: SearchIndexRebuildLease): Promise<void> {
	const [row] = await withCoreDb(env, (db) =>
		queryRows<{ current: boolean }>(
			db,
			sql`
				SELECT EXISTS (
				  SELECT 1
				  FROM search_index_states
				  WHERE index_name = ${SEARCH_INDEX_NAME}
				    AND generation = ${SEARCH_INDEX_GENERATION.ordinal}
				    AND generation_key = ${SEARCH_INDEX_GENERATION.key}
				    AND status = 'rebuilding'
				    AND rebuild_epoch = ${lease.rebuildEpoch}::bigint
				) AS current
			`,
		),
	);
	if (row?.current !== true) {
		throw new Error(
			`AI Search rebuild lease ${SEARCH_INDEX_GENERATION.ordinal}/${SEARCH_INDEX_GENERATION.key}/${lease.rebuildEpoch} is no longer current`,
		);
	}
}

async function withSearchIndexRebuildLease<T>(env: CoreEnv, lease: SearchIndexRebuildLease, operation: () => Promise<T>): Promise<T> {
	await assertResourceWritesEnabled(env, 'continue AI Search canonical rebuild');
	await assertSearchIndexRebuildLease(env, lease);
	return operation();
}

async function markSearchIndexGenerationReady(env: CoreEnv, lease: SearchIndexRebuildLease): Promise<{ readyAt: string }> {
	await assertResourceWritesEnabled(env, 'publish AI Search canonical readiness');
	const [row] = await withCoreDb(env, (db) =>
		queryRows<{ ready_at: string }>(
			db,
			sql`
				UPDATE search_index_states
				SET status = 'ready',
				    ready_at = COALESCE(ready_at, clock_timestamp()),
				    updated_at = clock_timestamp()
				WHERE index_name = ${SEARCH_INDEX_NAME}
				  AND generation = ${SEARCH_INDEX_GENERATION.ordinal}
				  AND generation_key = ${SEARCH_INDEX_GENERATION.key}
				  AND rebuild_epoch = ${lease.rebuildEpoch}::bigint
				RETURNING to_char(ready_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS ready_at
			`,
		),
	);
	if (!row) {
		throw new Error(
			`AI Search generation ${SEARCH_INDEX_GENERATION.ordinal}/${SEARCH_INDEX_GENERATION.key}/${lease.rebuildEpoch} lost its ready-state fence`,
		);
	}
	return { readyAt: row.ready_at };
}

type SearchIdentityCountRow = {
	count: string;
	kind: string;
	resource_platform: string | null;
};

type SearchIdentityCounts = {
	total: number;
	byIdentity: Record<string, number>;
};

function resourcePlatformMetadata(resourcePlatform: ResourcePlatform): string {
	return resourcePlatform ?? NULL_RESOURCE_PLATFORM_METADATA;
}

function searchIdentityKey(kind: ContentResourceKind, resourcePlatform: ResourcePlatform): string {
	return `${kind}/${resourcePlatformMetadata(resourcePlatform)}`;
}

function emptySearchIdentityCounts(): Record<string, number> {
	return Object.fromEntries(
		CANONICAL_CONTENT_IDENTITIES.map(({ kind, resourcePlatform }) => [searchIdentityKey(kind, resourcePlatform), 0]),
	);
}

function databaseCount(value: string, field: string): number {
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${field} count: ${value}`);
	return count;
}

async function loadSearchIdentityCounts(env: CoreEnv): Promise<SearchIdentityCounts> {
	const rows = await withCoreDb(env, (db) =>
		queryRows<SearchIdentityCountRow>(
			db,
			sql`
				SELECT r.kind,
				       r.resource_platform,
				       COUNT(*)::text AS count
				FROM resources r
				WHERE r.scope = 'corpus'
				  AND r.enrichment_status = 'enriched'
				  AND ${contentResourceIdentitySql({
						kind: sql`r.kind`,
						resourcePlatform: sql`r.resource_platform`,
					})}
				GROUP BY r.kind, r.resource_platform
			`,
		),
	);
	const byIdentity = emptySearchIdentityCounts();
	let total = 0;
	let invalid = 0;
	for (const row of rows) {
		const count = databaseCount(row.count, 'resource identity');
		total += count;
		const identity = parseResourceIdentity(row.kind, row.resource_platform);
		if (!identity || !(CONTENT_RESOURCE_KINDS as readonly ResourceKind[]).includes(identity.kind)) {
			invalid += count;
			continue;
		}
		const key = searchIdentityKey(identity.kind as ContentResourceKind, identity.resourcePlatform);
		if (!Object.hasOwn(byIdentity, key)) {
			invalid += count;
			continue;
		}
		byIdentity[key] += count;
	}
	if (invalid > 0) {
		throw new Error(`AI Search canonical preflight failed: invalid_identity=${invalid}`);
	}
	return { total, byIdentity };
}

async function listCorpusIdsAfter(env: CoreEnv, cursor: string | null): Promise<string[]> {
	return withCoreDb(env, async (db) => {
		const rows = await queryRows<{ id: string }>(
			db,
			sql`
				SELECT r.id::text
				FROM resources r
				WHERE r.scope = 'corpus'
				  AND r.enrichment_status = 'enriched'
				  AND ${contentResourceIdentitySql({
						kind: sql`r.kind`,
						resourcePlatform: sql`r.resource_platform`,
					})}
				  AND (${cursor}::uuid IS NULL OR r.id > ${cursor}::uuid)
				ORDER BY r.id
				LIMIT ${REINDEX_PAGE_SIZE}
			`,
		);
		return rows.map((row) => row.id);
	});
}

async function loadSearchItemPageCount(env: CoreEnv): Promise<number> {
	const listed = await env.AI_SEARCH.items.list({
		page: 1,
		per_page: REINDEX_PAGE_SIZE,
		sort_by: 'modified_at',
		source: 'builtin',
	});
	const totalCount = listed.result_info?.total_count;
	if (totalCount === undefined) throw new Error('AI Search item listing did not return total_count');
	return Math.ceil(totalCount / REINDEX_PAGE_SIZE);
}

async function loadEligibleCorpusIds(env: CoreEnv, resourceIds: readonly string[]): Promise<Set<string>> {
	if (!resourceIds.length) return new Set();
	return withCoreDb(env, async (db) => {
		const rows = await queryRows<{ id: string }>(
			db,
			sql`
				SELECT r.id::text
				FROM resources r
				WHERE r.id = ANY(${uuidArraySql(resourceIds)})
				  AND r.scope = 'corpus'
				  AND r.enrichment_status = 'enriched'
				  AND ${contentResourceIdentitySql({
						kind: sql`r.kind`,
						resourcePlatform: sql`r.resource_platform`,
					})}
			`,
		);
		return new Set(rows.map((row) => row.id));
	});
}

async function loadEligibleCorpusLatestUpdates(env: CoreEnv, resourceIds: readonly string[]): Promise<Map<string, number>> {
	if (!resourceIds.length) return new Map();
	const rows = await withCoreDb(env, (db) =>
		queryRows<{ id: string; latest_update_ms: string }>(
			db,
			sql`
				SELECT r.id::text,
				       CEIL(
				         EXTRACT(
				           EPOCH FROM (
				             GREATEST(
				             r.updated_at,
				             COALESCE(MAX(rt.updated_at), r.updated_at)
				             ) AT TIME ZONE 'UTC'
				           )
				         ) * 1000
				       )::bigint::text AS latest_update_ms
				FROM resources r
				LEFT JOIN resource_translations rt ON rt.resource_id = r.id
				WHERE r.id = ANY(${uuidArraySql(resourceIds)})
				  AND r.scope = 'corpus'
				  AND r.enrichment_status = 'enriched'
				  AND ${contentResourceIdentitySql({
						kind: sql`r.kind`,
						resourcePlatform: sql`r.resource_platform`,
					})}
				GROUP BY r.id, r.updated_at
			`,
		),
	);
	return new Map(
		rows.map((row) => {
			const latestUpdateMs = Number(row.latest_update_ms);
			if (!Number.isSafeInteger(latestUpdateMs) || latestUpdateMs < 0) {
				throw new Error(`AI Search repair candidate ${row.id} has an invalid latest update timestamp`);
			}
			return [row.id, latestUpdateMs];
		}),
	);
}

async function pruneSearchItemPage(env: CoreEnv, page: number): Promise<number> {
	const listed = await env.AI_SEARCH.items.list({
		page,
		per_page: REINDEX_PAGE_SIZE,
		sort_by: 'modified_at',
		source: 'builtin',
	});
	const ownedItems = listed.result.filter((item) => item.source_id === 'builtin' && item.key.startsWith(ITEM_PREFIX));
	const resourceIds = ownedItems.map((item) => idFromItemKey(item.key)).filter((id): id is string => id !== null);
	const eligibleIds = await loadEligibleCorpusIds(env, resourceIds);
	const staleItems = ownedItems.filter((item) => {
		const resourceId = idFromItemKey(item.key);
		return resourceId === null || !eligibleIds.has(resourceId);
	});

	for (let offset = 0; offset < staleItems.length; offset += REINDEX_AI_SEARCH_CONCURRENCY) {
		const batch = staleItems.slice(offset, offset + REINDEX_AI_SEARCH_CONCURRENCY);
		await Promise.all(batch.map((item) => env.AI_SEARCH.items.delete(item.id)));
	}
	if (staleItems.length) {
		console.info({ tag: 'AI_SEARCH', msg: 'Stale corpus items deleted', page, count: staleItems.length });
	}
	return staleItems.length;
}

async function pruneSearchItemPages(env: CoreEnv, firstPage: number, lastPage: number): Promise<number> {
	let deleted = 0;
	for (let page = lastPage; page >= firstPage; page--) {
		deleted += await pruneSearchItemPage(env, page);
	}
	return deleted;
}

async function uploadCorpusIds(env: CoreEnv, ids: readonly string[]): Promise<number> {
	let uploaded = 0;
	for (let offset = 0; offset < ids.length; offset += REINDEX_AI_SEARCH_CONCURRENCY) {
		const documents = await withCoreDb(env, (db) => loadCorpusDocuments(db, ids.slice(offset, offset + REINDEX_AI_SEARCH_CONCURRENCY)));
		await Promise.all(documents.map((document) => uploadCorpusDocument(env, document)));
		uploaded += documents.length;
	}
	return uploaded;
}

async function syncCorpusPageAfter(
	env: CoreEnv,
	cursor: string | null,
): Promise<{ cursor: string | null; done: boolean; uploaded: number }> {
	const ids = await listCorpusIdsAfter(env, cursor);
	if (!ids.length) return { cursor, done: true, uploaded: 0 };
	return { cursor: ids.at(-1)!, done: false, uploaded: await uploadCorpusIds(env, ids) };
}

type SearchDeltaCursor = {
	id: string;
	updatedAt: string;
};

type SearchDeltaRow = {
	id: string;
	updated_at: string;
};

async function listCorpusDeltaAfter(env: CoreEnv, startedAt: string, cursor: SearchDeltaCursor | null): Promise<SearchDeltaRow[]> {
	return withCoreDb(env, (db) =>
		queryRows<SearchDeltaRow>(
			db,
			sql`
				SELECT
				  r.id::text,
				  to_char(r.updated_at, ${UTC_TIMESTAMP_FORMAT}) AS updated_at
				FROM resources r
				WHERE r.scope = 'corpus'
				  AND r.enrichment_status = 'enriched'
				  AND ${contentResourceIdentitySql({
						kind: sql`r.kind`,
						resourcePlatform: sql`r.resource_platform`,
					})}
				  -- resources.updated_at is a legacy timestamp-without-time-zone
				  -- column whose stored contract is UTC. Convert it explicitly
				  -- before every timestamptz boundary/cursor comparison so the
				  -- Hyperdrive session timezone cannot change the delta window.
				  AND (r.updated_at AT TIME ZONE 'UTC') >= ${startedAt}::timestamptz
				  AND (
				    ${cursor?.updatedAt ?? null}::timestamptz IS NULL
				    OR (r.updated_at AT TIME ZONE 'UTC') > ${cursor?.updatedAt ?? null}::timestamptz
				    OR (
				      (r.updated_at AT TIME ZONE 'UTC') = ${cursor?.updatedAt ?? null}::timestamptz
				      AND r.id > ${cursor?.id ?? null}::uuid
				    )
				  )
				ORDER BY (r.updated_at AT TIME ZONE 'UTC'), r.id
				LIMIT ${REINDEX_PAGE_SIZE}
			`,
		),
	);
}

async function syncCorpusDeltaAfter(
	env: CoreEnv,
	startedAt: string,
	cursor: SearchDeltaCursor | null,
): Promise<{ cursor: SearchDeltaCursor | null; done: boolean; uploaded: number }> {
	const rows = await listCorpusDeltaAfter(env, startedAt, cursor);
	if (!rows.length) return { cursor, done: true, uploaded: 0 };
	const last = rows.at(-1)!;
	const nextCursor = { id: last.id, updatedAt: last.updated_at };
	if (cursor && nextCursor.id === cursor.id && nextCursor.updatedAt === cursor.updatedAt) {
		throw new Error('AI Search delta cursor did not advance');
	}
	return {
		cursor: nextCursor,
		done: false,
		uploaded: await uploadCorpusIds(
			env,
			rows.map((row) => row.id),
		),
	};
}

function normalizedCustomMetadata(
	fields: readonly { data_type: string; field_name: string }[] | undefined,
): Array<{ data_type: string; field_name: string }> {
	return (fields ?? [])
		.map((field) => ({ data_type: field.data_type, field_name: field.field_name.toLowerCase() }))
		.sort((left, right) => left.field_name.localeCompare(right.field_name));
}

function canonicalSearchInstanceConfigMatches(info: AiSearchInstanceInfo): boolean {
	return (
		info.index_method?.vector === true &&
		info.index_method.keyword === true &&
		info.fusion_method === 'rrf' &&
		info.indexing_options?.keyword_tokenizer === 'trigram' &&
		JSON.stringify(normalizedCustomMetadata(info.custom_metadata)) === JSON.stringify(normalizedCustomMetadata(CANONICAL_CUSTOM_METADATA))
	);
}

async function ensureCanonicalSearchInstanceConfig(env: CoreEnv): Promise<'unchanged' | 'updated'> {
	const info = await env.AI_SEARCH.info();
	if (canonicalSearchInstanceConfigMatches(info)) return 'unchanged';
	await env.AI_SEARCH.update({
		index_method: { vector: true, keyword: true },
		fusion_method: 'rrf',
		indexing_options: { keyword_tokenizer: 'trigram' },
		custom_metadata: [...CANONICAL_CUSTOM_METADATA],
	});
	return 'updated';
}

type SearchIndexStatsSnapshot = {
	completed: number;
	error: number;
	outdated: number;
	queued: number;
	running: number;
	skipped: number;
};

type SearchIndexReadinessObservation = {
	configReady: boolean;
	expected: SearchIdentityCounts;
	indexed: SearchIdentityCounts | null;
	ownedStatuses: SearchIndexStatsSnapshot;
	stats: SearchIndexStatsSnapshot;
};

type SearchIndexRepairTargetStatus = 'error' | 'outdated';

type SearchIndexRepairTarget = {
	error: string;
	itemId: string;
	lastSeenAt: string;
	resourceId: string;
	status: SearchIndexRepairTargetStatus;
};

type SearchIndexRepairTargetSnapshot = {
	counts: {
		error: number;
		outdated: number;
		total: number;
	};
	digest: string;
	targets: SearchIndexRepairTarget[];
};

type SearchIndexRepairBatchResult = {
	requested: number;
	requestedDigest: string;
	results: Array<{
		action: 'already-advanced' | 'uploaded';
		error: string | null;
		itemId: string;
		latestUpdateMs: number;
		pinnedItemId: string;
		previousLastSeenAt: string | null;
		previousStatus: AiSearchItemInfo['status'];
		resourceId: string;
		status: AiSearchItemInfo['status'];
		uploadReason: 'stale-stored-document' | 'terminal-retry' | null;
	}>;
};

function searchIndexStatsSnapshot(stats: AiSearchStatsResponse): SearchIndexStatsSnapshot {
	return {
		completed: stats.completed ?? 0,
		error: stats.error ?? 0,
		outdated: stats.outdated ?? 0,
		queued: stats.queued ?? 0,
		running: stats.running ?? 0,
		skipped: stats.skipped ?? 0,
	};
}

function compareAscii(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function parseAiSearchTimestamp(value: string | undefined): number {
	if (!value) return Number.NaN;
	const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
	return Date.parse(normalized);
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function searchIndexRepairTargetDigest(targets: readonly SearchIndexRepairTarget[]): Promise<string> {
	return sha256Hex(targets.map((target) => [target.itemId, target.resourceId, target.status, target.error].join('|')).join('\n'));
}

async function searchIndexRepairTargetSnapshot(targets: readonly SearchIndexRepairTarget[]): Promise<SearchIndexRepairTargetSnapshot> {
	const sortedTargets = [...targets].sort((left, right) => compareAscii(left.resourceId, right.resourceId));
	return {
		counts: {
			error: sortedTargets.filter((target) => target.status === 'error').length,
			outdated: sortedTargets.filter((target) => target.status === 'outdated').length,
			total: sortedTargets.length,
		},
		digest: await searchIndexRepairTargetDigest(sortedTargets),
		targets: sortedTargets,
	};
}

async function listOwnedSearchRepairStatusItems(env: CoreEnv, status: SearchIndexRepairTargetStatus): Promise<AiSearchItemInfo[]> {
	const items: AiSearchItemInfo[] = [];
	let expectedTotal: number | null = null;
	for (let page = 1; ; page++) {
		const listed = await env.AI_SEARCH.items.list({
			metadata_filter: JSON.stringify({ folder: ITEM_PREFIX }),
			page,
			per_page: REINDEX_REPAIR_LIST_PAGE_SIZE,
			sort_by: 'modified_at',
			source: 'builtin',
			status,
		});
		const total = listedItemCount(listed, `${status} repair candidate page ${page}`);
		if (!Number.isSafeInteger(total) || total < 0) {
			throw new Error(`AI Search ${status} repair candidate page ${page} returned an invalid total: ${total}`);
		}
		expectedTotal ??= total;
		if (total !== expectedTotal) {
			throw new Error(`AI Search ${status} repair candidate count changed while paging: ${expectedTotal}/${total}`);
		}
		items.push(...listed.result);
		if (items.length >= total) break;
		if (listed.result.length === 0) {
			throw new Error(`AI Search ${status} repair candidate paging stopped early: ${items.length}/${total}`);
		}
	}
	if (items.length !== expectedTotal) {
		throw new Error(`AI Search ${status} repair candidate paging mismatch: ${items.length}/${expectedTotal}`);
	}
	return items;
}

function parseSearchIndexRepairTarget(item: AiSearchItemInfo, status: SearchIndexRepairTargetStatus): SearchIndexRepairTarget {
	if (item.status !== status || item.source_id !== 'builtin') {
		throw new Error(`AI Search repair candidate ${item.id} did not match ${status}/builtin`);
	}
	if (!item.id.trim()) {
		throw new Error(`AI Search ${status} repair candidate is missing its item identity`);
	}
	const resourceId = idFromItemKey(item.key);
	if (!resourceId || item.key !== itemKey(resourceId)) {
		throw new Error(`AI Search repair candidate ${item.id} has an invalid owned resource key`);
	}
	const error = item.error?.trim() ?? '';
	if (status === 'error' && !error) {
		throw new Error(`AI Search repair candidate ${item.id} is missing its terminal error`);
	}
	const lastSeenAt = item.last_seen_at;
	const lastSeenMs = parseAiSearchTimestamp(lastSeenAt);
	if (!lastSeenAt || Number.isNaN(lastSeenMs)) {
		throw new Error(`AI Search repair candidate ${item.id} has an invalid last-seen timestamp`);
	}
	return {
		error,
		itemId: item.id,
		lastSeenAt,
		resourceId,
		status,
	};
}

async function loadSearchIndexRepairTargets(env: CoreEnv): Promise<SearchIndexRepairTargetSnapshot> {
	// Keep the two listings serialized to stay below the Worker connection cap.
	const errorItems = await listOwnedSearchRepairStatusItems(env, 'error');
	const outdatedItems = await listOwnedSearchRepairStatusItems(env, 'outdated');
	const targets = [
		...errorItems.map((item) => parseSearchIndexRepairTarget(item, 'error')),
		...outdatedItems.map((item) => parseSearchIndexRepairTarget(item, 'outdated')),
	].sort((left, right) => compareAscii(left.resourceId, right.resourceId));
	const itemIds = new Set(targets.map((target) => target.itemId));
	const resourceIds = new Set(targets.map((target) => target.resourceId));
	if (itemIds.size !== targets.length || resourceIds.size !== targets.length) {
		throw new Error('AI Search repair candidate set contains duplicate item or resource identities');
	}
	const latestUpdates = await loadEligibleCorpusLatestUpdates(env, [...resourceIds]);
	if (latestUpdates.size !== targets.length) {
		throw new Error(`AI Search repair candidate eligibility mismatch: ${latestUpdates.size}/${targets.length}`);
	}
	return searchIndexRepairTargetSnapshot(targets);
}

function assertSearchIndexRepairTargetSubset(snapshot: SearchIndexRepairTargetSnapshot, initial: SearchIndexRepairTargetSnapshot): void {
	const initialResourceIds = new Set(initial.targets.map((target) => target.resourceId));
	for (const target of snapshot.targets) {
		if (!initialResourceIds.has(target.resourceId)) {
			throw new Error(`AI Search repair retry introduced an unpinned target: ${target.itemId}/${target.resourceId}`);
		}
	}
}

function assertSearchIndexTerminalRepair251Targets(
	snapshot: SearchIndexRepairTargetSnapshot,
	checkpoint: SearchIndexTerminalRepair251Checkpoint,
): void {
	if (
		snapshot.counts.error !== checkpoint.initialRepairCounts.error ||
		snapshot.counts.outdated !== checkpoint.initialRepairCounts.outdated ||
		snapshot.counts.total !== checkpoint.initialRepairCounts.total ||
		snapshot.digest !== checkpoint.initialRepairTargetDigest
	) {
		throw new Error(
			`AI Search terminal repair target checkpoint mismatch: ${JSON.stringify({
				actual: { counts: snapshot.counts, digest: snapshot.digest },
				expected: {
					counts: checkpoint.initialRepairCounts,
					digest: checkpoint.initialRepairTargetDigest,
				},
			})}`,
		);
	}
}

async function verifySearchIndexTerminalRepair251Source(
	env: SearchIndexTerminalRepair251Env,
	checkpoint: SearchIndexTerminalRepair251Checkpoint,
) {
	const instance = await env.PHASE1_SEARCH_REBUILD_SOURCE.get(checkpoint.sourceInstanceId);
	const status = await instance.status();
	if (status.status !== 'errored') {
		throw new Error(`AI Search terminal repair source ${checkpoint.sourceInstanceId} is ${status.status}, not errored`);
	}
	const errorName = status.error?.name ?? '';
	const errorMessage = status.error?.message ?? '';
	if (errorName !== checkpoint.sourceErrorName || !errorMessage.startsWith(checkpoint.sourceErrorPrefix)) {
		throw new Error(`AI Search terminal repair source ${checkpoint.sourceInstanceId} did not fail at the pinned readiness fence`);
	}
	return {
		workflowName: checkpoint.sourceWorkflowName,
		instanceId: checkpoint.sourceInstanceId,
		status: status.status,
		error: { name: errorName, message: errorMessage },
	};
}

function searchIndexTerminalRepair251SourcesEqual(
	left: Awaited<ReturnType<typeof verifySearchIndexTerminalRepair251Source>>,
	right: Awaited<ReturnType<typeof verifySearchIndexTerminalRepair251Source>>,
): boolean {
	return (
		left.workflowName === right.workflowName &&
		left.instanceId === right.instanceId &&
		left.status === right.status &&
		left.error.name === right.error.name &&
		left.error.message === right.error.message
	);
}

type SearchIndexRepairCurrentTarget = {
	current: AiSearchItemInfo;
	target: SearchIndexRepairTarget;
};

async function resolveSearchIndexRepairCurrentTarget(
	env: CoreEnv,
	target: SearchIndexRepairTarget,
): Promise<SearchIndexRepairCurrentTarget> {
	const listed = await env.AI_SEARCH.items.list({
		per_page: REINDEX_PAGE_SIZE,
		search: target.resourceId,
		source: 'builtin',
	});
	const total = listedItemCount(listed, `current repair item ${target.resourceId}`);
	if (total > REINDEX_PAGE_SIZE) {
		throw new Error(`AI Search repair key lookup exceeded its single-page fence: ${total}/${REINDEX_PAGE_SIZE}`);
	}
	const matches = listed.result.filter((item) => item.key === itemKey(target.resourceId) && item.source_id === 'builtin');
	if (matches.length !== 1) {
		throw new Error(`AI Search repair could not resolve one current item for ${target.itemId}/${target.resourceId}: ${matches.length}`);
	}
	const [current] = matches;
	if (current.key !== itemKey(target.resourceId) || current.source_id !== 'builtin') {
		throw new Error(`AI Search repair inspection returned the wrong item for ${target.itemId}/${target.resourceId}`);
	}
	if (current.status === 'skipped') {
		throw new Error(`AI Search repair target ${target.itemId}/${target.resourceId} became skipped`);
	}
	return { current, target };
}

function searchIndexRepairTargetNeedsUpload(current: AiSearchItemInfo, latestUpdateMs: number): boolean {
	if (current.status === 'queued' || current.status === 'running') return false;
	if (current.status === 'error' || current.status === 'outdated') return true;
	const lastSeenMs = parseAiSearchTimestamp(current.last_seen_at);
	return Number.isNaN(lastSeenMs) || latestUpdateMs > lastSeenMs;
}

function searchIndexRepairResult(
	action: SearchIndexRepairBatchResult['results'][number]['action'],
	entry: SearchIndexRepairCurrentTarget,
	item: AiSearchItemInfo,
	latestUpdateMs: number,
): SearchIndexRepairBatchResult['results'][number] {
	const { current, target } = entry;
	if (item.status === 'skipped') throw new Error(`AI Search repair action skipped ${item.id}/${target.resourceId}`);
	if (item.key !== itemKey(target.resourceId) || item.source_id !== 'builtin') {
		throw new Error(`AI Search repair action returned the wrong item for ${target.itemId}/${target.resourceId}`);
	}
	const previousLastSeenMs = parseAiSearchTimestamp(current.last_seen_at);
	const storedItemWasStale = Number.isNaN(previousLastSeenMs) || latestUpdateMs > previousLastSeenMs;
	return {
		action,
		error: item.error?.trim() || null,
		itemId: item.id,
		latestUpdateMs,
		pinnedItemId: target.itemId,
		previousLastSeenAt: current.last_seen_at ?? null,
		previousStatus: current.status,
		resourceId: target.resourceId,
		status: item.status,
		uploadReason: action === 'uploaded' ? (storedItemWasStale ? 'stale-stored-document' : 'terminal-retry') : null,
	};
}

async function applySearchIndexRepairTarget(
	env: CoreEnv,
	entry: SearchIndexRepairCurrentTarget,
	latestUpdateMs: number,
	uploadDocument: CorpusDocument | undefined,
): Promise<SearchIndexRepairBatchResult['results'][number]> {
	const { current, target } = entry;
	if (current.status === 'queued' || current.status === 'running') {
		return searchIndexRepairResult('already-advanced', entry, current, latestUpdateMs);
	}
	if (uploadDocument) {
		const uploaded = await uploadCorpusDocument(env, uploadDocument);
		const observed = uploaded ?? (await resolveSearchIndexRepairCurrentTarget(env, target)).current;
		return searchIndexRepairResult('uploaded', entry, observed, latestUpdateMs);
	}
	if (current.status === 'completed') {
		return searchIndexRepairResult('already-advanced', entry, current, latestUpdateMs);
	}
	throw new Error(`AI Search repair target ${target.itemId}/${target.resourceId} had no valid upload or advanced action`);
}

async function applySearchIndexRepairTargets(
	env: CoreEnv,
	snapshot: SearchIndexRepairTargetSnapshot,
): Promise<SearchIndexRepairBatchResult> {
	if (snapshot.targets.length > REINDEX_AI_SEARCH_CONCURRENCY) {
		throw new Error(`AI Search repair action batch exceeded ${REINDEX_AI_SEARCH_CONCURRENCY} targets`);
	}
	const currentTargets = await Promise.all(snapshot.targets.map((target) => resolveSearchIndexRepairCurrentTarget(env, target)));
	const latestUpdates = await loadEligibleCorpusLatestUpdates(
		env,
		currentTargets.map(({ target }) => target.resourceId),
	);
	if (latestUpdates.size !== currentTargets.length) {
		throw new Error(`AI Search repair batch eligibility mismatch: ${latestUpdates.size}/${currentTargets.length}`);
	}
	const uploadIds = currentTargets.flatMap(({ current, target }) => {
		const latestUpdateMs = latestUpdates.get(target.resourceId);
		if (latestUpdateMs === undefined) throw new Error(`AI Search repair target ${target.resourceId} lost eligibility`);
		return searchIndexRepairTargetNeedsUpload(current, latestUpdateMs) ? [target.resourceId] : [];
	});
	const uploadDocuments = await withCoreDb(env, (db) => loadCorpusDocuments(db, uploadIds));
	if (uploadDocuments.length !== uploadIds.length) {
		throw new Error(`AI Search repair upload document mismatch: ${uploadDocuments.length}/${uploadIds.length}`);
	}
	const documentsById = new Map(uploadDocuments.map((document) => [document.id, document]));
	const results = await Promise.all(
		currentTargets.map((entry) => {
			const latestUpdateMs = latestUpdates.get(entry.target.resourceId);
			if (latestUpdateMs === undefined) throw new Error(`AI Search repair target ${entry.target.resourceId} lost eligibility`);
			return applySearchIndexRepairTarget(env, entry, latestUpdateMs, documentsById.get(entry.target.resourceId));
		}),
	);
	if (new Set(results.map((result) => result.itemId)).size !== results.length) {
		throw new Error('AI Search repair batch returned duplicate item identities');
	}
	return {
		requested: snapshot.targets.length,
		requestedDigest: snapshot.digest,
		results,
	};
}

async function applySearchIndexRepairRound(
	env: CoreEnv,
	step: WorkflowStep,
	lease: SearchIndexRebuildLease,
	snapshot: SearchIndexRepairTargetSnapshot,
	repairRound: number,
): Promise<number> {
	let batchCount = 0;
	for (let offset = 0; offset < snapshot.targets.length; offset += REINDEX_AI_SEARCH_CONCURRENCY) {
		const batchSnapshot = await searchIndexRepairTargetSnapshot(snapshot.targets.slice(offset, offset + REINDEX_AI_SEARCH_CONCURRENCY));
		await step.do(`apply-search-index-repair-targets-${repairRound}-${batchCount}`, BATCH_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(env, lease, () => applySearchIndexRepairTargets(env, batchSnapshot)),
		);
		batchCount++;
	}
	return batchCount;
}

function listedItemCount(listed: AiSearchListItemsResponse, label: string): number {
	const totalCount = listed.result_info?.total_count;
	if (totalCount === undefined) throw new Error(`AI Search ${label} listing did not return total_count`);
	return totalCount;
}

async function loadIndexedIdentityCounts(env: CoreEnv): Promise<SearchIdentityCounts> {
	const folderFilter = { folder: ITEM_PREFIX };
	const all = await env.AI_SEARCH.items.list({
		metadata_filter: JSON.stringify(folderFilter),
		page: 1,
		per_page: 1,
		source: 'builtin',
	});
	const byIdentity = emptySearchIdentityCounts();
	// Keep pair probes serialized. Total plus all six valid identity listings in
	// one fanout would exceed the Worker's six simultaneous connection ceiling.
	for (const { kind, resourcePlatform } of CANONICAL_CONTENT_IDENTITIES) {
		const platform = resourcePlatformMetadata(resourcePlatform);
		const listed = await env.AI_SEARCH.items.list({
			metadata_filter: JSON.stringify({
				...folderFilter,
				kind,
				resource_platform: platform,
			}),
			page: 1,
			per_page: 1,
			source: 'builtin',
		});
		byIdentity[searchIdentityKey(kind, resourcePlatform)] = listedItemCount(listed, `${kind}/${platform} metadata`);
	}
	return { total: listedItemCount(all, 'item'), byIdentity };
}

async function loadOwnedSearchItemStatuses(env: CoreEnv): Promise<SearchIndexStatsSnapshot> {
	const statusCount = async (status: AiSearchItemInfo['status']) =>
		listedItemCount(
			await env.AI_SEARCH.items.list({
				metadata_filter: JSON.stringify({ folder: ITEM_PREFIX }),
				page: 1,
				per_page: 1,
				source: 'builtin',
				status,
			}),
			`${status} item`,
		);
	// Keep readiness probes serialized. A surrounding readiness observation also
	// talks to PostgreSQL and AI Search stats; fanning all six status listings
	// out at once can exceed Workers' six-connection ceiling.
	const completed = await statusCount('completed');
	const error = await statusCount('error');
	const outdated = await statusCount('outdated');
	const queued = await statusCount('queued');
	const running = await statusCount('running');
	const skipped = await statusCount('skipped');
	return { completed, error, outdated, queued, running, skipped };
}

function searchIndexQueueDrained(stats: SearchIndexStatsSnapshot): boolean {
	return stats.queued === 0 && stats.running === 0;
}

function searchIndexSettled(stats: SearchIndexStatsSnapshot): boolean {
	return searchIndexQueueDrained(stats) && stats.outdated === 0;
}

function searchIdentityCountsEqual(left: SearchIdentityCounts, right: SearchIdentityCounts): boolean {
	return (
		left.total === right.total &&
		CANONICAL_CONTENT_IDENTITIES.every(
			({ kind, resourcePlatform }) =>
				left.byIdentity[searchIdentityKey(kind, resourcePlatform)] === right.byIdentity[searchIdentityKey(kind, resourcePlatform)],
		)
	);
}

function searchIndexReady(observation: SearchIndexReadinessObservation): boolean {
	return (
		observation.configReady &&
		searchIndexSettled(observation.ownedStatuses) &&
		observation.ownedStatuses.error === 0 &&
		observation.ownedStatuses.skipped === 0 &&
		observation.ownedStatuses.completed === observation.expected.total &&
		observation.indexed !== null &&
		searchIdentityCountsEqual(observation.indexed, observation.expected)
	);
}

async function loadSearchIndexReadiness(env: CoreEnv): Promise<SearchIndexReadinessObservation> {
	// Each child performs external I/O. Sequence the groups so database, config,
	// status, and per-identity probes never compete for the connection ceiling.
	const expected = await loadSearchIdentityCounts(env);
	const configReady = canonicalSearchInstanceConfigMatches(await env.AI_SEARCH.info());
	const ownedStatuses = await loadOwnedSearchItemStatuses(env);
	const rawStats = await env.AI_SEARCH.stats();
	const stats = searchIndexStatsSnapshot(rawStats);
	return {
		configReady,
		expected,
		indexed: searchIndexSettled(ownedStatuses) ? await loadIndexedIdentityCounts(env) : null,
		ownedStatuses,
		stats,
	};
}

async function waitForSearchIndexReady(
	env: CoreEnv,
	step: WorkflowStep,
	lease: SearchIndexRebuildLease,
	pollAttempts = REINDEX_READY_POLL_ATTEMPTS,
): Promise<SearchIndexReadinessObservation> {
	if (!Number.isSafeInteger(pollAttempts) || pollAttempts <= 0) {
		throw new Error(`AI Search readiness poll attempts must be a positive safe integer: ${pollAttempts}`);
	}
	let last: SearchIndexReadinessObservation | null = null;
	for (let attempt = 0; attempt < pollAttempts; attempt++) {
		last = await step.do(`load-search-index-readiness-${attempt}`, SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(env, lease, () => loadSearchIndexReadiness(env)),
		);
		if (searchIndexReady(last)) return last;
		if (
			searchIndexQueueDrained(last.ownedStatuses) &&
			(last.ownedStatuses.error > 0 || last.ownedStatuses.outdated > 0 || last.ownedStatuses.skipped > 0)
		) {
			return last;
		}
		if (attempt < pollAttempts - 1) {
			await step.sleep(`wait-search-index-readiness-${attempt}`, REINDEX_READY_POLL_INTERVAL);
		}
	}
	throw new Error(`AI Search index did not become ready: ${JSON.stringify(last)}`);
}

async function repairAndWaitForSearchIndexReady(
	env: CoreEnv,
	step: WorkflowStep,
	lease: SearchIndexRebuildLease,
	initialTargets: SearchIndexRepairTargetSnapshot,
	maxRepairRounds: number,
	pollAttempts = REINDEX_READY_POLL_ATTEMPTS,
): Promise<{ readiness: SearchIndexReadinessObservation; repairRoundsUsed: number }> {
	if (!Number.isSafeInteger(pollAttempts) || pollAttempts <= 0) {
		throw new Error(`AI Search repair readiness poll attempts must be a positive safe integer: ${pollAttempts}`);
	}
	if (!Number.isSafeInteger(maxRepairRounds) || maxRepairRounds <= 0) {
		throw new Error(`AI Search repair rounds must be a positive safe integer: ${maxRepairRounds}`);
	}
	await applySearchIndexRepairRound(env, step, lease, initialTargets, 0);
	await step.sleep('wait-search-index-repair-0', REINDEX_READY_POLL_INTERVAL);

	let last: SearchIndexReadinessObservation | null = null;
	let repairRoundsUsed = 1;
	for (let attempt = 0; attempt < pollAttempts; attempt++) {
		last = await step.do(`load-search-index-repair-readiness-${attempt}`, SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(env, lease, () => loadSearchIndexReadiness(env)),
		);
		if (searchIndexReady(last)) return { readiness: last, repairRoundsUsed };
		if (last.ownedStatuses.skipped > 0) {
			throw new Error(`AI Search indexing produced skipped items: ${JSON.stringify(last.ownedStatuses)}`);
		}
		if (last.ownedStatuses.error > 0 || last.ownedStatuses.outdated > 0) {
			if (repairRoundsUsed >= maxRepairRounds) {
				throw new Error(`AI Search terminal item repair exhausted ${maxRepairRounds} rounds: ${JSON.stringify(last.ownedStatuses)}`);
			}
			const repairRound = repairRoundsUsed;
			const retryTargets = await step.do(`inspect-search-index-repair-targets-${repairRound}`, SHORT_STEP_OPTIONS, () =>
				withSearchIndexRebuildLease(env, lease, async () => {
					const snapshot = await loadSearchIndexRepairTargets(env);
					assertSearchIndexRepairTargetSubset(snapshot, initialTargets);
					return snapshot;
				}),
			);
			await applySearchIndexRepairRound(env, step, lease, retryTargets, repairRound);
			repairRoundsUsed++;
		}
		if (attempt < pollAttempts - 1) {
			await step.sleep(`wait-search-index-repair-readiness-${attempt}`, REINDEX_READY_POLL_INTERVAL);
		}
	}
	throw new Error(`AI Search index did not become ready after targeted repair: ${JSON.stringify(last)}`);
}

async function reconcileSearchItems(env: CoreEnv, step: WorkflowStep, lease: SearchIndexRebuildLease) {
	let deleted = 0;
	for (let pass = 0; pass < REINDEX_MAX_PRUNE_PASSES; pass++) {
		const itemPageCount = await step.do(`load-search-item-page-count-${pass}`, SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(env, lease, () => loadSearchItemPageCount(env)),
		);
		let passDeleted = 0;
		// Delete from the last page first to avoid ordinary pagination shifts.
		// Repeat until a zero-delete pass to cover tie ordering and item movement.
		for (let lastPage = itemPageCount; lastPage >= 1; lastPage -= REINDEX_PRUNE_PAGES_PER_STEP) {
			const firstPage = Math.max(1, lastPage - REINDEX_PRUNE_PAGES_PER_STEP + 1);
			const batchDeleted = await step.do(`prune-search-item-pages-${pass}-${firstPage}-${lastPage}`, BATCH_STEP_OPTIONS, () =>
				withSearchIndexRebuildLease(env, lease, () => pruneSearchItemPages(env, firstPage, lastPage)),
			);
			passDeleted += batchDeleted;
		}
		deleted += passDeleted;
		if (passDeleted === 0) return { deleted, passes: pass + 1 };
	}
	throw new Error(`AI Search stale-item reconciliation did not converge after ${REINDEX_MAX_PRUNE_PASSES} passes`);
}

export async function startSearchIndexRebuild(env: CoreEnv): Promise<string> {
	await assertResourceWritesEnabled(env, 'AI Search canonical rebuild enqueue');
	return enqueueOrRestartWorkflow(env.SEARCH_INDEX_CANONICAL_REBUILD_WORKFLOW, SEARCH_INDEX_REBUILD_INSTANCE_ID, {});
}

export async function probeSearchIndexCutover(env: CoreEnv) {
	const observation = await loadSearchIndexReadiness(env);
	const indexed = observation.indexed ?? (await loadIndexedIdentityCounts(env));
	const completeObservation = { ...observation, indexed };
	return {
		indexName: SEARCH_INDEX_NAME,
		generation: SEARCH_INDEX_GENERATION,
		ready: searchIndexReady(completeObservation),
		...completeObservation,
	};
}

// This class must remain attached to its own physical Workflow resource. Durable
// executions replay the graph bound when they started; a new class or step name
// on an existing resource is not a contract boundary.
export class SearchIndexCanonicalV6RebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
		await assertResourceWritesEnabled(this.env, 'AI Search canonical rebuild workflow');
		const startedAt = await step.do('capture-canonical-v6-rebuild-started-at', async () => event.timestamp.toISOString());
		const lease = await step.do('begin-canonical-v6-search-index-generation', SHORT_STEP_OPTIONS, () => beginSearchIndexRebuild(this.env));

		const identityPreflight = await step.do('validate-canonical-v6-resource-identities', SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(this.env, lease, () => loadSearchIdentityCounts(this.env)),
		);
		const instanceConfig = await step.do('ensure-canonical-v6-search-instance-config', SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(this.env, lease, () => ensureCanonicalSearchInstanceConfig(this.env)),
		);
		let cursor: string | null = null;
		let uploaded = 0;
		let page = 0;

		while (true) {
			const result = await step.do(`sync-canonical-v6-corpus-page-${page}`, BATCH_STEP_OPTIONS, () =>
				withSearchIndexRebuildLease(this.env, lease, () => syncCorpusPageAfter(this.env, cursor)),
			);
			if (result.done) break;
			if (!result.cursor) throw new Error(`AI Search rebuild page ${page} did not return a cursor`);
			uploaded += result.uploaded;

			cursor = result.cursor;
			page++;
			console.info({
				tag: 'AI_SEARCH',
				msg: 'Index rebuild page complete',
				page,
				cursor,
				uploaded,
			});
		}

		let deltaCursor: SearchDeltaCursor | null = null;
		let deltaPage = 0;
		let deltaUploaded = 0;
		while (true) {
			const result = await step.do(`sync-canonical-v6-corpus-delta-page-${deltaPage}`, BATCH_STEP_OPTIONS, () =>
				withSearchIndexRebuildLease(this.env, lease, () => syncCorpusDeltaAfter(this.env, startedAt, deltaCursor)),
			);
			if (result.done) break;
			if (!result.cursor) throw new Error(`AI Search delta page ${deltaPage} did not return a cursor`);
			deltaUploaded += result.uploaded;
			deltaCursor = result.cursor;
			deltaPage++;
		}
		const reconciliation = await reconcileSearchItems(this.env, step, lease);
		let readiness = await waitForSearchIndexReady(this.env, step, lease);
		let repair: { roundsUsed: number; targets: SearchIndexRepairTargetSnapshot } | null = null;
		if (!searchIndexReady(readiness)) {
			if (readiness.ownedStatuses.skipped > 0) {
				throw new Error(`AI Search indexing produced skipped items: ${JSON.stringify(readiness.ownedStatuses)}`);
			}
			const targets = await step.do('inspect-canonical-v6-search-index-repair-targets', SHORT_STEP_OPTIONS, () =>
				withSearchIndexRebuildLease(this.env, lease, () => loadSearchIndexRepairTargets(this.env)),
			);
			if (targets.targets.length === 0) {
				throw new Error(`AI Search index is not ready and has no repairable terminal items: ${JSON.stringify(readiness)}`);
			}
			const repaired = await repairAndWaitForSearchIndexReady(this.env, step, lease, targets, 3);
			readiness = repaired.readiness;
			repair = { roundsUsed: repaired.repairRoundsUsed, targets };
		}
		if (!searchIndexReady(readiness)) {
			throw new Error(`AI Search canonical v6 readiness contract failed: ${JSON.stringify(readiness)}`);
		}
		const generationReadiness = await step.do('mark-canonical-v6-search-index-generation-ready', SHORT_STEP_OPTIONS, () =>
			markSearchIndexGenerationReady(this.env, lease),
		);

		return {
			mode: 'rebuild' as const,
			startedAt,
			generation: SEARCH_INDEX_GENERATION,
			rebuildEpoch: lease.rebuildEpoch,
			identityPreflight,
			instanceConfig,
			uploaded,
			pages: page,
			deltaUploaded,
			deltaPages: deltaPage,
			reconciliation,
			repair,
			readiness,
			generationReadiness,
		};
	}
}

export class SearchIndexTerminalRepair251Workflow extends WorkflowEntrypoint<SearchIndexTerminalRepair251Env, Record<string, never>> {
	async run(event: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
		await assertResourceWritesEnabled(this.env, 'AI Search terminal repair #251 workflow');
		const checkpoint = searchIndexTerminalRepair251Checkpoint();
		if (event.workflowName !== checkpoint.repairWorkflowName || event.instanceId !== checkpoint.repairInstanceId) {
			throw new Error(`AI Search terminal repair #251 rejected Workflow identity ${event.workflowName}/${event.instanceId}`);
		}
		if (Object.keys(event.payload).length > 0) {
			throw new Error('AI Search terminal repair #251 does not accept operator-supplied parameters');
		}
		const bindingBeforeClaim = await step.do('verify-terminal-repair-search-binding', SHORT_STEP_OPTIONS, () =>
			verifySearchIndexTerminalRepair251Binding(this.env, checkpoint),
		);
		const sourceBeforeClaim = await step.do('verify-phase1-search-rebuild-source', SHORT_STEP_OPTIONS, () =>
			verifySearchIndexTerminalRepair251Source(this.env, checkpoint),
		);
		const initialTargets = await step.do('snapshot-terminal-search-repair-targets', SHORT_STEP_OPTIONS, async () => {
			const snapshot = await loadSearchIndexRepairTargets(this.env);
			assertSearchIndexTerminalRepair251Targets(snapshot, checkpoint);
			return snapshot;
		});
		const claim = await step.do('claim-terminal-search-repair-lease', SHORT_STEP_OPTIONS, () =>
			claimSearchIndexTerminalRepair251(this.env, checkpoint, event.timestamp.toISOString()),
		);
		const sourceAfterClaim = await step.do('reverify-phase1-search-rebuild-source', SHORT_STEP_OPTIONS, () =>
			verifySearchIndexTerminalRepair251Source(this.env, checkpoint),
		);
		if (!searchIndexTerminalRepair251SourcesEqual(sourceBeforeClaim, sourceAfterClaim)) {
			throw new Error('AI Search terminal repair source changed while claiming the fenced lease');
		}
		const targetsAfterClaim = await step.do('recheck-terminal-search-repair-targets', SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(this.env, claim, async () => {
				const snapshot = await loadSearchIndexRepairTargets(this.env);
				assertSearchIndexRepairTargetSubset(snapshot, initialTargets);
				return snapshot;
			}),
		);
		const repaired = await repairAndWaitForSearchIndexReady(this.env, step, claim, initialTargets, checkpoint.maxRepairRounds);
		if (!searchIndexReady(repaired.readiness)) {
			throw new Error(`AI Search terminal repair #251 readiness contract failed: ${JSON.stringify(repaired.readiness)}`);
		}
		const sourceBeforeReady = await step.do('final-reverify-phase1-search-rebuild-source', SHORT_STEP_OPTIONS, () =>
			verifySearchIndexTerminalRepair251Source(this.env, checkpoint),
		);
		if (!searchIndexTerminalRepair251SourcesEqual(sourceAfterClaim, sourceBeforeReady)) {
			throw new Error('AI Search terminal repair source changed before ready publication');
		}
		const bindingBeforeReady = await step.do('final-reverify-terminal-repair-search-binding', SHORT_STEP_OPTIONS, () =>
			verifySearchIndexTerminalRepair251Binding(this.env, checkpoint),
		);
		if (JSON.stringify(bindingBeforeClaim) !== JSON.stringify(bindingBeforeReady)) {
			throw new Error('AI Search terminal repair binding changed before ready publication');
		}
		const finalReadiness = await step.do('final-load-terminal-repair-readiness', SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(this.env, claim, () => loadSearchIndexReadiness(this.env)),
		);
		if (!searchIndexReady(finalReadiness)) {
			throw new Error(`AI Search terminal repair #251 final readiness fence failed: ${JSON.stringify(finalReadiness)}`);
		}
		const generationReadiness = await step.do('mark-terminal-repair-generation-ready', SHORT_STEP_OPTIONS, () =>
			markSearchIndexGenerationReady(this.env, claim),
		);
		return {
			mode: 'terminal-repair-251' as const,
			checkpoint: {
				generation: checkpoint.generation,
				generationKey: checkpoint.generationKey,
				sourceInstanceId: checkpoint.sourceInstanceId,
				sourceRebuildEpoch: checkpoint.sourceRebuildEpoch,
				initialRepairCounts: checkpoint.initialRepairCounts,
				initialRepairTargetDigest: checkpoint.initialRepairTargetDigest,
			},
			binding: { beforeClaim: bindingBeforeClaim, beforeReady: bindingBeforeReady },
			source: { beforeClaim: sourceBeforeClaim, afterClaim: sourceAfterClaim, beforeReady: sourceBeforeReady },
			claim,
			targets: { initial: initialTargets, afterClaim: targetsAfterClaim },
			repairRoundsUsed: repaired.repairRoundsUsed,
			readiness: finalReadiness,
			generationReadiness,
		};
	}
}
