import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
	type ContentResourceIdentity,
	type ContentResourceKind,
	isContentResourceIdentity,
	parseResourceIdentity,
	type ResourceCategory,
	type ResourcePlatform,
} from '@core-shared/resource-types';
import { type CoreDb, isValidUuid, queryRows, textArraySql, uuidArraySql, withCoreDb } from '@db/client';
import { contentResourceIdentitySql, resourceDisplaySourceSql } from '@db/resource-identity-sql';
import { sql } from 'drizzle-orm';
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
	{ kind: 'blog', resourcePlatform: null },
	{ kind: 'forum', resourcePlatform: 'hackernews' },
	{ kind: 'post', resourcePlatform: 'twitter' },
	{ kind: 'video', resourcePlatform: 'youtube' },
	{ kind: 'paper', resourcePlatform: null },
	{ kind: 'paper', resourcePlatform: 'hackernews' },
] as const satisfies readonly ContentResourceIdentity[];
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

function corpusDocumentIdentity(document: CorpusDocument): ContentResourceIdentity {
	const identity = parseResourceIdentity(document.kind, document.resource_platform);
	if (!identity || !isContentResourceIdentity(identity)) {
		throw new Error(
			`AI Search document ${document.id} has invalid persisted identity ${String(document.kind)} / ${String(document.resource_platform)}`,
		);
	}
	return identity;
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

async function deleteCorpusItem(env: CoreEnv, resourceId: string): Promise<boolean> {
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
const SEARCH_INDEX_GENERATION = { key: 'canonical-5-blog-forum-kind', ordinal: 5 } as const;
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
const REINDEX_REPAIR_MAX_LIST_PAGES = 100;
const REINDEX_MAX_REPAIR_ROUNDS = 3;
// One merged loop now covers both the initial indexing wait and repair
// convergence, so this carries the former two loops' 36+36 budget.
const REINDEX_READY_POLL_ATTEMPTS = 72;
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
	return writeSearchIndexRebuildingState(env, true);
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
	await assertSearchIndexRebuildLease(env, lease);
	return operation();
}

async function markSearchIndexGenerationReady(env: CoreEnv, lease: SearchIndexRebuildLease): Promise<{ readyAt: string }> {
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

function searchIdentityKey(identity: ContentResourceIdentity): string {
	return `${identity.kind}/${resourcePlatformMetadata(identity.resourcePlatform)}`;
}

function emptySearchIdentityCounts(): Record<string, number> {
	return Object.fromEntries(CANONICAL_CONTENT_IDENTITIES.map((identity) => [searchIdentityKey(identity), 0]));
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
		if (!identity || !isContentResourceIdentity(identity)) {
			invalid += count;
			continue;
		}
		const key = searchIdentityKey(identity);
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
	resourceId: string;
	status: SearchIndexRepairTargetStatus;
};

type SearchIndexRepairTargetSnapshot = {
	counts: {
		error: number;
		outdated: number;
		total: number;
	};
	targets: SearchIndexRepairTarget[];
};

type SearchIndexRepairActionResult = {
	action: 'already-advanced' | 'synced' | 'uploaded';
	itemId: string;
	previousStatus: AiSearchItemInfo['status'] | null;
	resourceId: string;
	status: AiSearchItemInfo['status'];
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

async function listOwnedSearchRepairStatusItems(env: CoreEnv, status: SearchIndexRepairTargetStatus): Promise<AiSearchItemInfo[]> {
	const items: AiSearchItemInfo[] = [];
	for (let page = 1; page <= REINDEX_REPAIR_MAX_LIST_PAGES; page++) {
		const listed = await env.AI_SEARCH.items.list({
			metadata_filter: JSON.stringify({ folder: ITEM_PREFIX }),
			page,
			per_page: REINDEX_REPAIR_LIST_PAGE_SIZE,
			sort_by: 'modified_at',
			source: 'builtin',
			status,
		});
		items.push(...listed.result);
		// Set drift while paging is tolerable: apply re-reads each item by id, and
		// later poll rounds pick up anything a shifted page missed.
		if (listed.result.length < REINDEX_REPAIR_LIST_PAGE_SIZE) return items;
	}
	throw new Error(`AI Search ${status} repair listing exceeded ${REINDEX_REPAIR_MAX_LIST_PAGES} pages`);
}

function parseSearchIndexRepairTarget(item: AiSearchItemInfo, status: SearchIndexRepairTargetStatus): SearchIndexRepairTarget {
	const resourceId = idFromItemKey(item.key);
	if (!item.id.trim() || !resourceId || item.key !== itemKey(resourceId) || item.source_id !== 'builtin') {
		throw new Error(`AI Search repair candidate ${item.id} is not an owned ${status} corpus item`);
	}
	return {
		error: item.error?.trim() ?? '',
		itemId: item.id,
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
	return {
		counts: {
			error: targets.filter((target) => target.status === 'error').length,
			outdated: targets.filter((target) => target.status === 'outdated').length,
			total: targets.length,
		},
		targets,
	};
}

function assertSearchIndexRepairTargetSubset(snapshot: SearchIndexRepairTargetSnapshot, initial: SearchIndexRepairTargetSnapshot): void {
	const initialResourceIds = new Set(initial.targets.map((target) => target.resourceId));
	for (const target of snapshot.targets) {
		if (!initialResourceIds.has(target.resourceId)) {
			throw new Error(`AI Search repair retry introduced an unpinned target: ${target.itemId}/${target.resourceId}`);
		}
	}
}

type SearchIndexRepairDecision = SearchIndexRepairActionResult['action'];

function decideSearchIndexRepairAction(current: AiSearchItemInfo | null, latestUpdateMs: number): SearchIndexRepairDecision {
	if (current && (current.status === 'queued' || current.status === 'running')) return 'already-advanced';
	const lastSeenMs = parseAiSearchTimestamp(current?.last_seen_at);
	// A stored document older than the DB row (or an unreadable item) must be
	// re-uploaded: sync would only re-index the stale stored content.
	if (!current || Number.isNaN(lastSeenMs) || latestUpdateMs > lastSeenMs) return 'uploaded';
	if (current.status === 'completed') return 'already-advanced';
	return 'synced';
}

async function applySearchIndexRepairTargets(
	env: CoreEnv,
	targets: readonly SearchIndexRepairTarget[],
): Promise<SearchIndexRepairActionResult[]> {
	if (targets.length > REINDEX_AI_SEARCH_CONCURRENCY) {
		throw new Error(`AI Search repair action batch exceeded ${REINDEX_AI_SEARCH_CONCURRENCY} targets`);
	}
	const latestUpdates = await loadEligibleCorpusLatestUpdates(
		env,
		targets.map((target) => target.resourceId),
	);
	const entries = await Promise.all(
		targets.map(async (target) => {
			let current: AiSearchItemInfo | null = null;
			try {
				current = await env.AI_SEARCH.items.get(target.itemId).info();
			} catch (error) {
				// A concurrent re-upload can retire the pinned item id; the upload
				// decision below recreates the key either way.
				console.warn({
					tag: 'AI_SEARCH',
					msg: 'Repair target item unreadable; falling back to upload',
					item_id: target.itemId,
					resource_id: target.resourceId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			const latestUpdateMs = latestUpdates.get(target.resourceId);
			if (latestUpdateMs === undefined) throw new Error(`AI Search repair target ${target.resourceId} lost eligibility`);
			return { action: decideSearchIndexRepairAction(current, latestUpdateMs), current, target };
		}),
	);
	const uploadIds = entries.filter((entry) => entry.action === 'uploaded').map((entry) => entry.target.resourceId);
	const uploadDocuments = await withCoreDb(env, (db) => loadCorpusDocuments(db, uploadIds));
	if (uploadDocuments.length !== uploadIds.length) {
		throw new Error(`AI Search repair upload document mismatch: ${uploadDocuments.length}/${uploadIds.length}`);
	}
	const documentsById = new Map(uploadDocuments.map((document) => [document.id, document]));
	return Promise.all(
		entries.map(async ({ action, current, target }): Promise<SearchIndexRepairActionResult> => {
			const previousStatus = current?.status ?? null;
			if (action === 'already-advanced') {
				if (!current) throw new Error(`AI Search repair target ${target.itemId} advanced without an observed item`);
				return { action, itemId: current.id, previousStatus, resourceId: target.resourceId, status: current.status };
			}
			if (action === 'uploaded') {
				const document = documentsById.get(target.resourceId);
				if (!document) throw new Error(`AI Search repair target ${target.resourceId} has no eligible corpus document`);
				const uploaded = await uploadCorpusDocument(env, document);
				return {
					action,
					itemId: uploaded?.id ?? target.itemId,
					previousStatus,
					resourceId: target.resourceId,
					status: uploaded?.status ?? 'queued',
				};
			}
			const item = env.AI_SEARCH.items.get(target.itemId);
			await item.sync();
			// sync() re-indexes the stored content but returns null at runtime
			// despite its declared item-info type — re-read for the observed state.
			const observed = await item.info();
			if (observed.status === 'skipped') {
				throw new Error(`AI Search repair sync skipped ${target.itemId}/${target.resourceId}`);
			}
			return { action, itemId: observed.id, previousStatus, resourceId: target.resourceId, status: observed.status };
		}),
	);
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
		const batch = snapshot.targets.slice(offset, offset + REINDEX_AI_SEARCH_CONCURRENCY);
		await step.do(`repair-search-index-items-${repairRound}-${batchCount}`, BATCH_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(env, lease, () => applySearchIndexRepairTargets(env, batch)),
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
	for (const identity of CANONICAL_CONTENT_IDENTITIES) {
		const { kind, resourcePlatform } = identity;
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
		byIdentity[searchIdentityKey(identity)] = listedItemCount(listed, `${kind}/${platform} metadata`);
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
			(identity) => left.byIdentity[searchIdentityKey(identity)] === right.byIdentity[searchIdentityKey(identity)],
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

type SearchIndexReadyOutcome = {
	readiness: SearchIndexReadinessObservation;
	repair: { roundsUsed: number; targets: SearchIndexRepairTargetSnapshot } | null;
};

async function repairSearchIndexTerminalItems(
	env: CoreEnv,
	step: WorkflowStep,
	lease: SearchIndexRebuildLease,
	observation: SearchIndexReadinessObservation,
	pinned: SearchIndexRepairTargetSnapshot | null,
	round: number,
): Promise<SearchIndexRepairTargetSnapshot> {
	const targets = await step.do(`inspect-search-index-repair-targets-${round}`, SHORT_STEP_OPTIONS, () =>
		withSearchIndexRebuildLease(env, lease, () => loadSearchIndexRepairTargets(env)),
	);
	if (pinned === null) {
		if (targets.targets.length === 0) {
			throw new Error(`AI Search index is not ready and has no repairable terminal items: ${JSON.stringify(observation)}`);
		}
	} else {
		// Repair converges on the broken set observed after queue drain; a retry
		// round growing that set means something new is failing.
		assertSearchIndexRepairTargetSubset(targets, pinned);
	}
	if (targets.targets.length > 0) {
		await applySearchIndexRepairRound(env, step, lease, targets, round);
	}
	return pinned ?? targets;
}

async function waitForSearchIndexReady(
	env: CoreEnv,
	step: WorkflowStep,
	lease: SearchIndexRebuildLease,
	maxRepairRounds: number,
	pollAttempts = REINDEX_READY_POLL_ATTEMPTS,
): Promise<SearchIndexReadyOutcome> {
	if (!Number.isSafeInteger(pollAttempts) || pollAttempts <= 0) {
		throw new Error(`AI Search readiness poll attempts must be a positive safe integer: ${pollAttempts}`);
	}
	if (!Number.isSafeInteger(maxRepairRounds) || maxRepairRounds <= 0) {
		throw new Error(`AI Search repair rounds must be a positive safe integer: ${maxRepairRounds}`);
	}
	let pinned: SearchIndexRepairTargetSnapshot | null = null;
	let roundsUsed = 0;
	let last: SearchIndexReadinessObservation | null = null;
	for (let attempt = 0; attempt < pollAttempts; attempt++) {
		last = await step.do(`observe-search-index-readiness-${attempt}`, SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(env, lease, () => loadSearchIndexReadiness(env)),
		);
		if (searchIndexReady(last)) {
			return { readiness: last, repair: pinned ? { roundsUsed, targets: pinned } : null };
		}
		if (last.ownedStatuses.skipped > 0) {
			throw new Error(`AI Search indexing produced skipped items: ${JSON.stringify(last.ownedStatuses)}`);
		}
		const hasTerminalItems = last.ownedStatuses.error > 0 || last.ownedStatuses.outdated > 0;
		if (hasTerminalItems && searchIndexQueueDrained(last.ownedStatuses)) {
			if (roundsUsed >= maxRepairRounds) {
				throw new Error(`AI Search terminal item repair exhausted ${maxRepairRounds} rounds: ${JSON.stringify(last.ownedStatuses)}`);
			}
			pinned = await repairSearchIndexTerminalItems(env, step, lease, last, pinned, roundsUsed);
			roundsUsed++;
		}
		if (attempt < pollAttempts - 1) {
			await step.sleep(`wait-search-index-readiness-${attempt}`, REINDEX_READY_POLL_INTERVAL);
		}
	}
	throw new Error(`AI Search index did not become ready: ${JSON.stringify(last)}`);
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
	return enqueueOrRestartWorkflow(env.SEARCH_INDEX_GENERATION_5_REBUILD_WORKFLOW, SEARCH_INDEX_REBUILD_INSTANCE_ID, {});
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
export class SearchIndexGeneration5RebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
		const startedAt = await step.do('capture-generation-5-rebuild-started-at', async () => event.timestamp.toISOString());
		const lease = await step.do('begin-generation-5-search-index', SHORT_STEP_OPTIONS, () => beginSearchIndexRebuild(this.env));

		const identityPreflight = await step.do('validate-generation-5-resource-identities', SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(this.env, lease, () => loadSearchIdentityCounts(this.env)),
		);
		const instanceConfig = await step.do('ensure-generation-5-search-instance-config', SHORT_STEP_OPTIONS, () =>
			withSearchIndexRebuildLease(this.env, lease, () => ensureCanonicalSearchInstanceConfig(this.env)),
		);
		let cursor: string | null = null;
		let uploaded = 0;
		let page = 0;

		while (true) {
			const result = await step.do(`sync-generation-5-corpus-page-${page}`, BATCH_STEP_OPTIONS, () =>
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
			const result = await step.do(`sync-generation-5-corpus-delta-page-${deltaPage}`, BATCH_STEP_OPTIONS, () =>
				withSearchIndexRebuildLease(this.env, lease, () => syncCorpusDeltaAfter(this.env, startedAt, deltaCursor)),
			);
			if (result.done) break;
			if (!result.cursor) throw new Error(`AI Search delta page ${deltaPage} did not return a cursor`);
			deltaUploaded += result.uploaded;
			deltaCursor = result.cursor;
			deltaPage++;
		}
		const reconciliation = await reconcileSearchItems(this.env, step, lease);
		const { readiness, repair } = await waitForSearchIndexReady(this.env, step, lease, REINDEX_MAX_REPAIR_ROUNDS);
		if (!searchIndexReady(readiness)) {
			throw new Error(`AI Search generation 5 readiness contract failed: ${JSON.stringify(readiness)}`);
		}
		const generationReadiness = await step.do('mark-generation-5-search-index-ready', SHORT_STEP_OPTIONS, () =>
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
