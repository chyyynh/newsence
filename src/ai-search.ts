import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
	CONTENT_RESOURCE_KINDS,
	CONTENT_RESOURCE_TYPES,
	type ContentResourceKind,
	type ContentResourceType,
	hasSemanticScholarAcademicEnrichment,
	LEGACY_RESOURCE_IDENTITIES,
	legacyResourceIdentity,
	parseResourceIdentity,
	type ResourceCategory,
	type ResourceKind,
	type ResourcePlatform,
} from '@core-shared/resource-types';
import { type CoreDb, isValidUuid, queryRows, textArraySql, uuidArraySql, withCoreDb } from '@db/client';
import { contentResourceIdentitySql, resourceDisplaySourceSql } from '@db/resource-identity-sql';
import { sql } from 'drizzle-orm';
import { enqueueOrRestartWorkflow } from './workflow-control';

// Cloudflare AI Search allows at most five custom metadata fields per
// instance. During the dual-read window, keep the exact legacy type filter and
// spend the fifth field on kind. #251 replaces type with resource_platform and
// stores null as an explicit `none` sentinel.
// https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/
const AI_SEARCH_CUSTOM_METADATA_FIELD_LIMIT = 5;
const CANONICAL_CUSTOM_METADATA = [
	{ field_name: 'effective_at', data_type: 'datetime' },
	{ field_name: 'source_id', data_type: 'text' },
	{ field_name: 'type', data_type: 'text' },
	{ field_name: 'category', data_type: 'text' },
	{ field_name: 'kind', data_type: 'text' },
] as const satisfies NonNullable<AiSearchConfig['custom_metadata']>;
if (CANONICAL_CUSTOM_METADATA.length > AI_SEARCH_CUSTOM_METADATA_FIELD_LIMIT) {
	throw new Error(`AI Search custom metadata exceeds the ${AI_SEARCH_CUSTOM_METADATA_FIELD_LIMIT}-field limit`);
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
	type: ContentResourceType;
	kind: string | null;
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
	types?: readonly ContentResourceType[];
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

function corpusDocumentKind(document: CorpusDocument): ContentResourceKind {
	const persisted = parseResourceIdentity(document.kind, document.resource_platform);
	if (!persisted && (document.kind !== null || document.resource_platform !== null)) {
		throw new Error(
			`AI Search document ${document.id} has invalid persisted identity ${String(document.kind)} / ${String(document.resource_platform)}`,
		);
	}
	const identity = persisted ?? legacyResourceIdentity(document.type, hasSemanticScholarAcademicEnrichment(document.platform_metadata));
	if (!(CONTENT_RESOURCE_KINDS as readonly ResourceKind[]).includes(identity.kind)) {
		throw new Error(`AI Search document ${document.id} has non-content kind ${identity.kind}`);
	}
	return identity.kind as ContentResourceKind;
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
				       r.type,
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
									type: sql`r.type`,
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
							type: sql`r.type`,
						})}
		`,
	);
}

async function loadCorpusDocument(db: CoreDb, resourceId: string): Promise<CorpusDocument | null> {
	return (await loadCorpusDocuments(db, [resourceId]))[0] ?? null;
}

function corpusItemMetadata(document: CorpusDocument): Record<string, unknown> {
	const effectiveAt = documentEffectiveAt(document);
	return {
		...(effectiveAt ? { effective_at: effectiveAt } : {}),
		...(document.source_id ? { source_id: document.source_id } : {}),
		type: document.type,
		...(document.category ? { category: document.category } : {}),
		kind: corpusDocumentKind(document),
	};
}

async function uploadCorpusDocument(env: CoreEnv, document: CorpusDocument): Promise<void> {
	const startedAt = Date.now();
	const result = await env.AI_SEARCH.items.upload(itemKey(document.id), serializeDocument(document), {
		metadata: corpusItemMetadata(document),
	});
	console.info({
		tag: 'AI_SEARCH',
		msg: 'Corpus item queued',
		resource_id: document.id,
		item_id: result.id,
		latency_ms: Date.now() - startedAt,
	});
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

export async function deleteCorpusItem(env: CoreEnv, resourceId: string): Promise<boolean> {
	const key = itemKey(resourceId);
	// Search by the bare id, not the full key: a value containing `/` is parsed as
	// a folder metadata filter and rejected with 7001 "metadata filter pattern
	// exceeds maximum length", so passing `resources/<id>.md` failed every call.
	// The REST API grew an exact-`key` parameter, but the Workers binding type has
	// no such field yet — the exact-match filter below covers the difference.
	const listed = await env.AI_SEARCH.items.list({ search: resourceId, source: 'builtin', per_page: 1 });
	const matches = listed.result.filter((item) => item.key === key && item.source_id === 'builtin');
	await Promise.all(matches.map((item) => env.AI_SEARCH.items.delete(item.id)));
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

function legacyTypeFilter(options: CorpusSearchOptions): ContentResourceType[] | null | undefined {
	const explicitTypes = options.types ? new Set(options.types) : null;
	const platformTypes = options.resourcePlatforms
		? CONTENT_RESOURCE_TYPES.filter((type) => options.resourcePlatforms?.includes(LEGACY_RESOURCE_IDENTITIES[type].resourcePlatform))
		: null;
	if (!explicitTypes && !platformTypes) return undefined;
	const compatible = platformTypes ?? [...(explicitTypes ?? [])];
	const filtered = explicitTypes ? compatible.filter((type) => explicitTypes.has(type)) : compatible;
	return filtered.length ? filtered : null;
}

function searchFilters(options: CorpusSearchOptions): VectorizeVectorMetadataFilter | null | undefined {
	if (
		options.sourceIds?.length === 0 ||
		options.categories?.length === 0 ||
		options.kinds?.length === 0 ||
		options.resourcePlatforms?.length === 0 ||
		options.types?.length === 0
	) {
		return null;
	}
	const filters: VectorizeVectorMetadataFilter = {};
	if (options.sourceIds?.length) {
		filters.source_id = { $in: [...options.sourceIds] };
	}
	const types = legacyTypeFilter(options);
	if (types === null) return null;
	if (types) filters.type = { $in: types };
	if (options.categories?.length) filters.category = { $in: [...options.categories] };
	if (options.kinds?.length) filters.kind = { $in: [...options.kinds] };
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

const SEARCH_INDEX_GENERATION = 'canonical-3-kind';
const REINDEX_PAGE_SIZE = 50;
const REINDEX_UPLOAD_CONCURRENCY = 10;
const REINDEX_DELETE_CONCURRENCY = 10;
const REINDEX_MAX_PRUNE_PASSES = 3;
// Batch prune pages and combine corpus reads/uploads below so the current full
// rebuild stays under the 1,024-step Workflow limit on Workers Free.
const REINDEX_PRUNE_PAGES_PER_STEP = 10;
const REINDEX_READY_POLL_ATTEMPTS = 36;
const REINDEX_READY_POLL_INTERVAL = '10 minutes';
const STEP_RETRIES = { limit: 5, delay: '10 seconds', backoff: 'exponential' } as const;
const SHORT_STEP_OPTIONS = { retries: STEP_RETRIES, timeout: '60 seconds' } as const;
const BATCH_STEP_OPTIONS = { retries: STEP_RETRIES, timeout: '300 seconds' } as const;

type SearchIdentityCountRow = {
	count: string;
	kind: string | null;
	platform_proxy_drift: string;
};

type SearchIdentityCounts = {
	total: number;
	byKind: Record<ContentResourceKind, number>;
};

function emptySearchKindCounts(): Record<ContentResourceKind, number> {
	return { document: 0, post: 0, video: 0, paper: 0 };
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
				       COUNT(*)::text AS count,
				       COUNT(*) FILTER (
				         WHERE NOT (
				           (r.type = 'twitter' AND r.resource_platform IS NOT DISTINCT FROM 'twitter')
				           OR (r.type = 'youtube' AND r.resource_platform IS NOT DISTINCT FROM 'youtube')
				           OR (r.type = 'hackernews' AND r.resource_platform IS NOT DISTINCT FROM 'hackernews')
				           OR (r.type = ANY(${textArraySql(['web', 'rss', 'pdf'])}) AND r.resource_platform IS NULL)
				         )
				       )::text AS platform_proxy_drift
				FROM resources r
				WHERE r.scope = 'corpus'
				  AND r.enrichment_status = 'enriched'
				  AND ${contentResourceIdentitySql({
						kind: sql`r.kind`,
						resourcePlatform: sql`r.resource_platform`,
						type: sql`r.type`,
					})}
				GROUP BY r.kind
			`,
		),
	);
	const byKind = emptySearchKindCounts();
	let total = 0;
	let missing = 0;
	let platformProxyDrift = 0;
	for (const row of rows) {
		const count = databaseCount(row.count, 'resource identity');
		total += count;
		platformProxyDrift += databaseCount(row.platform_proxy_drift, 'platform proxy drift');
		if (row.kind === null) {
			missing += count;
		} else if ((CONTENT_RESOURCE_KINDS as readonly string[]).includes(row.kind)) {
			byKind[row.kind as ContentResourceKind] = count;
		} else {
			throw new Error(`AI Search preflight found invalid content kind ${row.kind}`);
		}
	}
	if (missing > 0 || platformProxyDrift > 0) {
		throw new Error(`AI Search preflight failed: missing_kind=${missing}, legacy_platform_proxy_drift=${platformProxyDrift}`);
	}
	return { total, byKind };
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
						type: sql`r.type`,
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
						type: sql`r.type`,
					})}
			`,
		);
		return new Set(rows.map((row) => row.id));
	});
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

	for (let offset = 0; offset < staleItems.length; offset += REINDEX_DELETE_CONCURRENCY) {
		const batch = staleItems.slice(offset, offset + REINDEX_DELETE_CONCURRENCY);
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
	for (let offset = 0; offset < ids.length; offset += REINDEX_UPLOAD_CONCURRENCY) {
		const documents = await withCoreDb(env, (db) => loadCorpusDocuments(db, ids.slice(offset, offset + REINDEX_UPLOAD_CONCURRENCY)));
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
				SELECT r.id::text, r.updated_at::text AS updated_at
				FROM resources r
				WHERE r.scope = 'corpus'
				  AND r.enrichment_status = 'enriched'
				  AND ${contentResourceIdentitySql({
						kind: sql`r.kind`,
						resourcePlatform: sql`r.resource_platform`,
						type: sql`r.type`,
					})}
				  AND r.updated_at >= ${startedAt}::timestamptz
				  AND (
				    ${cursor?.updatedAt ?? null}::timestamptz IS NULL
				    OR r.updated_at > ${cursor?.updatedAt ?? null}::timestamptz
				    OR (r.updated_at = ${cursor?.updatedAt ?? null}::timestamptz AND r.id > ${cursor?.id ?? null}::uuid)
				  )
				ORDER BY r.updated_at, r.id
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

async function ensureSearchInstanceConfig(env: CoreEnv): Promise<'unchanged' | 'updated'> {
	const info = await env.AI_SEARCH.info();
	if (
		info.index_method?.vector === true &&
		info.index_method.keyword === true &&
		info.fusion_method === 'rrf' &&
		info.indexing_options?.keyword_tokenizer === 'trigram' &&
		JSON.stringify(normalizedCustomMetadata(info.custom_metadata)) === JSON.stringify(normalizedCustomMetadata(CANONICAL_CUSTOM_METADATA))
	) {
		return 'unchanged';
	}
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
	expected: SearchIdentityCounts;
	indexed: SearchIdentityCounts | null;
	ownedStatuses: SearchIndexStatsSnapshot;
	stats: SearchIndexStatsSnapshot;
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

function listedItemCount(listed: AiSearchListItemsResponse, label: string): number {
	const totalCount = listed.result_info?.total_count;
	if (totalCount === undefined) throw new Error(`AI Search ${label} listing did not return total_count`);
	return totalCount;
}

async function loadIndexedIdentityCounts(env: CoreEnv): Promise<SearchIdentityCounts> {
	const folderFilter = { folder: ITEM_PREFIX };
	const [all, ...kindListings] = await Promise.all([
		env.AI_SEARCH.items.list({
			metadata_filter: JSON.stringify(folderFilter),
			page: 1,
			per_page: 1,
			source: 'builtin',
		}),
		...CONTENT_RESOURCE_KINDS.map((kind) =>
			env.AI_SEARCH.items.list({
				metadata_filter: JSON.stringify({ ...folderFilter, kind }),
				page: 1,
				per_page: 1,
				source: 'builtin',
			}),
		),
	]);
	const byKind = emptySearchKindCounts();
	for (const [index, kind] of CONTENT_RESOURCE_KINDS.entries()) {
		byKind[kind] = listedItemCount(kindListings[index], `${kind} metadata`);
	}
	return { total: listedItemCount(all, 'item'), byKind };
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
	const [completed, error, outdated, queued, running, skipped] = await Promise.all([
		statusCount('completed'),
		statusCount('error'),
		statusCount('outdated'),
		statusCount('queued'),
		statusCount('running'),
		statusCount('skipped'),
	]);
	return { completed, error, outdated, queued, running, skipped };
}

function searchIndexSettled(stats: SearchIndexStatsSnapshot): boolean {
	return stats.queued === 0 && stats.running === 0 && stats.outdated === 0;
}

function searchIdentityCountsEqual(left: SearchIdentityCounts, right: SearchIdentityCounts): boolean {
	return left.total === right.total && CONTENT_RESOURCE_KINDS.every((kind) => left.byKind[kind] === right.byKind[kind]);
}

function searchIndexReady(observation: SearchIndexReadinessObservation): boolean {
	return (
		searchIndexSettled(observation.ownedStatuses) &&
		observation.ownedStatuses.error === 0 &&
		observation.ownedStatuses.skipped === 0 &&
		observation.ownedStatuses.completed === observation.expected.total &&
		observation.indexed !== null &&
		searchIdentityCountsEqual(observation.indexed, observation.expected)
	);
}

async function loadSearchIndexReadiness(env: CoreEnv): Promise<SearchIndexReadinessObservation> {
	const [expected, ownedStatuses, rawStats] = await Promise.all([
		loadSearchIdentityCounts(env),
		loadOwnedSearchItemStatuses(env),
		env.AI_SEARCH.stats(),
	]);
	const stats = searchIndexStatsSnapshot(rawStats);
	return {
		expected,
		indexed: searchIndexSettled(ownedStatuses) ? await loadIndexedIdentityCounts(env) : null,
		ownedStatuses,
		stats,
	};
}

async function waitForSearchIndexReady(env: CoreEnv, step: WorkflowStep): Promise<SearchIndexReadinessObservation> {
	let last: SearchIndexReadinessObservation | null = null;
	for (let attempt = 0; attempt < REINDEX_READY_POLL_ATTEMPTS; attempt++) {
		last = await step.do(`load-search-index-readiness-${attempt}`, SHORT_STEP_OPTIONS, () => loadSearchIndexReadiness(env));
		if (searchIndexReady(last)) return last;
		if (searchIndexSettled(last.ownedStatuses) && (last.ownedStatuses.error > 0 || last.ownedStatuses.skipped > 0)) {
			throw new Error(`AI Search indexing failed: ${JSON.stringify(last.ownedStatuses)}`);
		}
		if (attempt < REINDEX_READY_POLL_ATTEMPTS - 1) {
			await step.sleep(`wait-search-index-readiness-${attempt}`, REINDEX_READY_POLL_INTERVAL);
		}
	}
	throw new Error(`AI Search index did not become ready: ${JSON.stringify(last)}`);
}

async function reconcileSearchItems(env: CoreEnv, step: WorkflowStep) {
	let deleted = 0;
	for (let pass = 0; pass < REINDEX_MAX_PRUNE_PASSES; pass++) {
		const itemPageCount = await step.do(`load-search-item-page-count-${pass}`, SHORT_STEP_OPTIONS, () => loadSearchItemPageCount(env));
		let passDeleted = 0;
		// Delete from the last page first to avoid ordinary pagination shifts.
		// Repeat until a zero-delete pass to cover tie ordering and item movement.
		for (let lastPage = itemPageCount; lastPage >= 1; lastPage -= REINDEX_PRUNE_PAGES_PER_STEP) {
			const firstPage = Math.max(1, lastPage - REINDEX_PRUNE_PAGES_PER_STEP + 1);
			const batchDeleted = await step.do(`prune-search-item-pages-${pass}-${firstPage}-${lastPage}`, BATCH_STEP_OPTIONS, () =>
				pruneSearchItemPages(env, firstPage, lastPage),
			);
			passDeleted += batchDeleted;
		}
		deleted += passDeleted;
		if (passDeleted === 0) return { deleted, passes: pass + 1 };
	}
	throw new Error(`AI Search stale-item reconciliation did not converge after ${REINDEX_MAX_PRUNE_PASSES} passes`);
}

export function startSearchIndexRebuild(env: CoreEnv): Promise<string> {
	return enqueueOrRestartWorkflow(env.SEARCH_INDEX_REBUILD_WORKFLOW, `search-index-rebuild-${SEARCH_INDEX_GENERATION}`, {});
}

export class SearchIndexRebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(_event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
		// restart() keeps an instance's immutable event payload. Capture this inside
		// the execution so every full restart receives a fresh delta boundary while
		// ordinary step retries keep the same durable value.
		const startedAt = await step.do('capture-search-rebuild-started-at', async () => new Date().toISOString());

		const identityPreflight = await step.do('validate-search-resource-identities', SHORT_STEP_OPTIONS, () =>
			loadSearchIdentityCounts(this.env),
		);
		const instanceConfig = await step.do('ensure-search-instance-config', SHORT_STEP_OPTIONS, () => ensureSearchInstanceConfig(this.env));
		let cursor: string | null = null;
		let uploaded = 0;
		let page = 0;

		while (true) {
			const result = await step.do(`sync-corpus-page-${page}`, BATCH_STEP_OPTIONS, () => syncCorpusPageAfter(this.env, cursor));
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
			const result = await step.do(`sync-corpus-delta-page-${deltaPage}`, BATCH_STEP_OPTIONS, () =>
				syncCorpusDeltaAfter(this.env, startedAt, deltaCursor),
			);
			if (result.done) break;
			if (!result.cursor) throw new Error(`AI Search delta page ${deltaPage} did not return a cursor`);
			deltaUploaded += result.uploaded;
			deltaCursor = result.cursor;
			deltaPage++;
		}
		const reconciliation = await reconcileSearchItems(this.env, step);
		// items.upload() is intentionally queue-oriented for throughput. Workflow
		// completion is the reader cutover gate, so do not return until Cloudflare
		// reports no pending/error/outdated items and indexed kind counts match DB.
		const readiness = await waitForSearchIndexReady(this.env, step);

		return {
			startedAt,
			identityPreflight,
			instanceConfig,
			uploaded,
			pages: page,
			deltaUploaded,
			deltaPages: deltaPage,
			reconciliation,
			readiness,
		};
	}
}
