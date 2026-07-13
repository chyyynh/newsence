import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { CONTENT_RESOURCE_TYPES, type ContentResourceType, type ResourceCategory } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { isValidUuid, queryRows, textArraySql, uuidArraySql } from '@db/sql';
import { sql } from 'drizzle-orm';
import { enqueueOrRestartWorkflow } from './workflow-control';

const LEGACY_INSTANCE_NAME = 'newsence-corpus';
const SHADOW_INSTANCE_NAME = 'newsence-corpus-v5';
const WRITE_INSTANCE_NAMES = [LEGACY_INSTANCE_NAME, SHADOW_INSTANCE_NAME] as const;
type SearchInstanceName = (typeof WRITE_INSTANCE_NAMES)[number];
const READ_INSTANCE_NAME: SearchInstanceName = LEGACY_INSTANCE_NAME;

const CANONICAL_CUSTOM_METADATA = [
	{ field_name: 'effective_at', data_type: 'datetime' },
	{ field_name: 'source_id', data_type: 'text' },
	{ field_name: 'type', data_type: 'text' },
	{ field_name: 'category', data_type: 'text' },
] as const satisfies NonNullable<AiSearchConfig['custom_metadata']>;
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
	original_lang: string;
	published_at: Date | string | null;
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
	profile?: CorpusSearchProfile;
	sourceIds?: readonly string[];
	types?: readonly ContentResourceType[];
};

async function listCorpusIdsAfter(env: CoreEnv, cursor: string | null, limit = 50): Promise<string[]> {
	return withCoreDb(env, async (db) => {
		const rows = await queryRows<{ id: string }>(
			db,
			sql`
				SELECT id::text
				FROM resources
					WHERE scope = 'corpus'
					  AND enrichment_status = 'enriched'
					  AND type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
				  AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
				ORDER BY id
				LIMIT ${Math.min(Math.max(limit, 1), 50)}
			`,
		);
		return rows.map((row) => row.id);
	});
}

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
	if (row.published_at === null) return undefined;
	const date = new Date(row.published_at);
	if (Number.isNaN(date.getTime())) throw new Error(`AI Search document ${row.id} has invalid effective date`);
	return date.toISOString();
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
				       r.original_lang,
				       COALESCE(r.published_date, r.scraped_date, r.created_at) AS published_at,
				       r.tags,
				       r.category,
				       COALESCE(NULLIF(s.name, ''), NULLIF(r.platform_metadata->>'sourceName', ''), r.type) AS source,
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
					  AND r.type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
		`,
	);
}

async function loadCorpusDocument(db: CoreDb, resourceId: string): Promise<CorpusDocument | null> {
	return (await loadCorpusDocuments(db, [resourceId]))[0] ?? null;
}

function corpusItemMetadata(instanceName: SearchInstanceName, document: CorpusDocument): Record<string, unknown> {
	const effectiveAt = documentEffectiveAt(document);
	if (instanceName === LEGACY_INSTANCE_NAME) {
		return {
			...(effectiveAt ? { published_at: effectiveAt } : {}),
			language: document.original_lang,
			source: requiredDocumentText(document.source, 'source', document.id),
			type: document.type,
			...(document.category ? { category: document.category } : {}),
		};
	}
	return {
		...(effectiveAt ? { effective_at: effectiveAt } : {}),
		...(document.source_id ? { source_id: document.source_id } : {}),
		type: document.type,
		...(document.category ? { category: document.category } : {}),
	};
}

async function uploadCorpusDocument(env: CoreEnv, instanceName: SearchInstanceName, document: CorpusDocument): Promise<void> {
	const startedAt = Date.now();
	const result = await env.AI_SEARCH.get(instanceName).items.upload(itemKey(document.id), serializeDocument(document), {
		metadata: corpusItemMetadata(instanceName, document),
	});
	console.info({
		tag: 'AI_SEARCH',
		msg: 'Corpus item queued',
		instance: instanceName,
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
	await Promise.all(WRITE_INSTANCE_NAMES.map((instanceName) => uploadCorpusDocument(env, instanceName, document)));
	return 'uploaded';
}

async function deleteCorpusItemFromInstance(env: CoreEnv, instanceName: SearchInstanceName, resourceId: string): Promise<boolean> {
	const key = itemKey(resourceId);
	// Exact-key filtering shipped on 2026-07-08; the Workers binding type has
	// not caught up with the documented `key` parameter yet.
	const instance = env.AI_SEARCH.get(instanceName);
	const listed = await instance.items.list({ key, source: 'builtin', per_page: 1 } as AiSearchListItemsParams & {
		key: string;
	});
	const matches = listed.result.filter((item) => item.key === key && item.source_id === 'builtin');
	await Promise.all(matches.map((item) => instance.items.delete(item.id)));
	if (matches.length) {
		console.info({ tag: 'AI_SEARCH', msg: 'Corpus item deleted', instance: instanceName, resource_id: resourceId, count: matches.length });
	}
	return matches.length > 0;
}

export async function deleteCorpusItem(env: CoreEnv, resourceId: string): Promise<boolean> {
	const deleted = await Promise.all(
		WRITE_INSTANCE_NAMES.map((instanceName) => deleteCorpusItemFromInstance(env, instanceName, resourceId)),
	);
	return deleted.some(Boolean);
}

function searchFilters(instanceName: SearchInstanceName, options: CorpusSearchOptions): VectorizeVectorMetadataFilter | undefined {
	const filters: VectorizeVectorMetadataFilter = {};
	if (instanceName === SHADOW_INSTANCE_NAME && options.sourceIds?.length) {
		filters.source_id = { $in: [...options.sourceIds] };
	}
	if (options.types?.length) filters.type = { $in: [...options.types] };
	if (options.categories?.length) filters.category = { $in: [...options.categories] };
	if (options.effectiveAfter || options.effectiveBefore) {
		const field = instanceName === SHADOW_INSTANCE_NAME ? 'effective_at' : 'published_at';
		filters[field] = {
			...(options.effectiveAfter ? { $gte: options.effectiveAfter.toISOString() } : {}),
			...(options.effectiveBefore ? { $lte: options.effectiveBefore.toISOString() } : {}),
		};
	}
	return Object.keys(filters).length ? filters : undefined;
}

export async function searchCorpusRanks(env: CoreEnv, query: string, options: CorpusSearchOptions = {}): Promise<AiSearchRank[]> {
	const profile = options.profile ?? 'discovery';
	const retrievalType = profile === 'related' ? 'vector' : 'hybrid';
	const filters = searchFilters(READ_INSTANCE_NAME, options);
	const effectiveAtField = READ_INSTANCE_NAME === SHADOW_INSTANCE_NAME ? 'effective_at' : 'published_at';
	const response = await env.AI_SEARCH.get(READ_INSTANCE_NAME).search({
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
				...(profile === 'related' ? {} : { boost_by: [{ field: effectiveAtField, direction: 'desc' as const }] }),
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

type SearchIndexRebuildPayload = {
	revision: string;
	skipPrune?: boolean;
	startCursor?: string | null;
	startedAt: string;
	targetInstance: SearchInstanceName;
};

const SEARCH_INDEX_REVISION = 'v5-shadow-2';
const REINDEX_PAGE_SIZE = 50;
const REINDEX_UPLOAD_CONCURRENCY = 10;
const REINDEX_DELETE_CONCURRENCY = 10;
const REINDEX_MAX_PRUNE_PASSES = 3;
// Batch prune pages and combine corpus reads/uploads below so the current full
// rebuild stays under the 1,024-step Workflow limit on Workers Free.
const REINDEX_PRUNE_PAGES_PER_STEP = 10;

type SearchItemPageAudit = {
	deleted: number;
	scanned: number;
};

async function loadSearchItemPageCount(env: CoreEnv, instanceName: SearchInstanceName): Promise<number> {
	const listed = await env.AI_SEARCH.get(instanceName).items.list({
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
				SELECT id::text
				FROM resources
				WHERE id = ANY(${uuidArraySql(resourceIds)})
				  AND scope = 'corpus'
				  AND enrichment_status = 'enriched'
				  AND type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
			`,
		);
		return new Set(rows.map((row) => row.id));
	});
}

async function pruneSearchItemPage(env: CoreEnv, instanceName: SearchInstanceName, page: number): Promise<SearchItemPageAudit> {
	const instance = env.AI_SEARCH.get(instanceName);
	const listed = await instance.items.list({
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
		await Promise.all(batch.map((item) => instance.items.delete(item.id)));
	}
	if (staleItems.length) {
		console.info({ tag: 'AI_SEARCH', msg: 'Stale corpus items deleted', instance: instanceName, page, count: staleItems.length });
	}
	return { deleted: staleItems.length, scanned: listed.result.length };
}

async function pruneSearchItemPages(
	env: CoreEnv,
	instanceName: SearchInstanceName,
	firstPage: number,
	lastPage: number,
): Promise<SearchItemPageAudit> {
	let deleted = 0;
	let scanned = 0;
	for (let page = lastPage; page >= firstPage; page--) {
		const audit = await pruneSearchItemPage(env, instanceName, page);
		deleted += audit.deleted;
		scanned += audit.scanned;
	}
	return { deleted, scanned };
}

async function syncCorpusPageAfter(
	env: CoreEnv,
	instanceName: SearchInstanceName,
	cursor: string | null,
): Promise<{ cursor: string | null; done: boolean; uploaded: number }> {
	const ids = await listCorpusIdsAfter(env, cursor, REINDEX_PAGE_SIZE);
	if (!ids.length) return { cursor, done: true, uploaded: 0 };

	let uploaded = 0;
	for (let offset = 0; offset < ids.length; offset += REINDEX_UPLOAD_CONCURRENCY) {
		const batch = ids.slice(offset, offset + REINDEX_UPLOAD_CONCURRENCY);
		const documents = await withCoreDb(env, (db) => loadCorpusDocuments(db, batch));
		await Promise.all(documents.map((document) => uploadCorpusDocument(env, instanceName, document)));
		uploaded += documents.length;
	}
	return { cursor: ids.at(-1)!, done: false, uploaded };
}

type SearchDeltaCursor = {
	id: string;
	updatedAt: string;
};

type SearchDeltaRow = {
	id: string;
	updated_at: string;
};

function isoDate(value: Date | string, field: string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}`);
	return date.toISOString();
}

async function listCorpusDeltaAfter(
	env: CoreEnv,
	startedAt: string,
	cursor: SearchDeltaCursor | null,
	limit = REINDEX_PAGE_SIZE,
): Promise<SearchDeltaRow[]> {
	return withCoreDb(env, (db) =>
		queryRows<SearchDeltaRow>(
			db,
			sql`
				SELECT id::text, updated_at::text AS updated_at
				FROM resources
				WHERE scope = 'corpus'
				  AND enrichment_status = 'enriched'
				  AND type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
				  AND updated_at >= ${startedAt}::timestamptz
				  AND (
				    ${cursor?.updatedAt ?? null}::timestamptz IS NULL
				    OR updated_at > ${cursor?.updatedAt ?? null}::timestamptz
				    OR (updated_at = ${cursor?.updatedAt ?? null}::timestamptz AND id > ${cursor?.id ?? null}::uuid)
				  )
				ORDER BY updated_at, id
				LIMIT ${Math.min(Math.max(limit, 1), REINDEX_PAGE_SIZE)}
			`,
		),
	);
}

async function syncCorpusDeltaAfter(
	env: CoreEnv,
	instanceName: SearchInstanceName,
	startedAt: string,
	cursor: SearchDeltaCursor | null,
): Promise<{ cursor: SearchDeltaCursor | null; done: boolean; uploaded: number }> {
	const rows = await listCorpusDeltaAfter(env, startedAt, cursor);
	if (!rows.length) return { cursor, done: true, uploaded: 0 };

	let uploaded = 0;
	for (let offset = 0; offset < rows.length; offset += REINDEX_UPLOAD_CONCURRENCY) {
		const batch = rows.slice(offset, offset + REINDEX_UPLOAD_CONCURRENCY);
		const documents = await withCoreDb(env, (db) =>
			loadCorpusDocuments(
				db,
				batch.map((row) => row.id),
			),
		);
		await Promise.all(documents.map((document) => uploadCorpusDocument(env, instanceName, document)));
		uploaded += documents.length;
	}
	const last = rows.at(-1)!;
	const nextCursor = { id: last.id, updatedAt: last.updated_at };
	if (cursor && nextCursor.id === cursor.id && nextCursor.updatedAt === cursor.updatedAt) {
		throw new Error('AI Search delta cursor did not advance');
	}
	return {
		cursor: nextCursor,
		done: false,
		uploaded,
	};
}

async function ensureSearchInstanceConfig(env: CoreEnv, instanceName: SearchInstanceName): Promise<'unchanged' | 'updated'> {
	const instance = env.AI_SEARCH.get(instanceName);
	const info = await instance.info();
	if (
		info.index_method?.vector === true &&
		info.index_method.keyword === true &&
		info.fusion_method === 'rrf' &&
		info.indexing_options?.keyword_tokenizer === 'trigram' &&
		JSON.stringify(info.custom_metadata ?? []) === JSON.stringify(CANONICAL_CUSTOM_METADATA)
	) {
		return 'unchanged';
	}
	await instance.update({
		index_method: { vector: true, keyword: true },
		fusion_method: 'rrf',
		indexing_options: { keyword_tokenizer: 'trigram' },
		custom_metadata: [...CANONICAL_CUSTOM_METADATA],
	});
	return 'updated';
}

type SearchReconciliation = {
	deleted: number;
	passes: number;
	scanned: number;
};

async function reconcileSearchItems(
	env: CoreEnv,
	step: WorkflowStep,
	instanceName: SearchInstanceName,
	phase: 'pre' | 'final',
): Promise<SearchReconciliation> {
	let deleted = 0;
	let scanned = 0;
	let passes = 0;
	while (passes < REINDEX_MAX_PRUNE_PASSES) {
		const itemPageCount = await step.do(
			`${phase}-load-search-item-page-count-${passes}`,
			{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			() => loadSearchItemPageCount(env, instanceName),
		);
		let passDeleted = 0;
		// Delete from the last page first to avoid ordinary pagination shifts.
		// Repeat until a zero-delete pass to cover tie ordering and item movement.
		for (let lastPage = itemPageCount; lastPage >= 1; lastPage -= REINDEX_PRUNE_PAGES_PER_STEP) {
			const firstPage = Math.max(1, lastPage - REINDEX_PRUNE_PAGES_PER_STEP + 1);
			const audit = await step.do(
				`${phase}-prune-search-item-pages-${passes}-${firstPage}-${lastPage}`,
				{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				() => pruneSearchItemPages(env, instanceName, firstPage, lastPage),
			);
			passDeleted += audit.deleted;
			scanned += audit.scanned;
		}
		deleted += passDeleted;
		passes++;
		if (passDeleted === 0) break;
		if (passes === REINDEX_MAX_PRUNE_PASSES) {
			throw new Error(`AI Search ${phase} stale-item reconciliation did not converge after ${passes} passes`);
		}
	}
	return { deleted, passes, scanned };
}

export function startSearchIndexRebuild(env: CoreEnv): Promise<string> {
	return enqueueOrRestartWorkflow(env.SEARCH_INDEX_REBUILD_WORKFLOW, `search-index-rebuild-${SEARCH_INDEX_REVISION}-batched`, {
		revision: SEARCH_INDEX_REVISION,
		skipPrune: false,
		startCursor: null,
		startedAt: new Date().toISOString(),
		targetInstance: SHADOW_INSTANCE_NAME,
	});
}

export class SearchIndexRebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
		const startCursor = event.payload.startCursor ?? null;
		if (startCursor !== null && !isValidUuid(startCursor)) throw new Error('Invalid search rebuild start cursor');
		if (event.payload.targetInstance !== SHADOW_INSTANCE_NAME) throw new Error('Search rebuild target must be the v5 shadow index');
		const startedAt = isoDate(event.payload.startedAt, 'search rebuild startedAt');

		const instanceConfig = await step.do(
			'ensure-search-instance-config',
			{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			() => ensureSearchInstanceConfig(this.env, event.payload.targetInstance),
		);
		const preReconciliation = event.payload.skipPrune
			? { deleted: 0, passes: 0, scanned: 0 }
			: await reconcileSearchItems(this.env, step, event.payload.targetInstance, 'pre');
		let cursor = startCursor;
		let uploaded = 0;
		let page = 0;

		while (true) {
			const result = await step.do(
				`sync-corpus-page-${page}`,
				{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				() => syncCorpusPageAfter(this.env, event.payload.targetInstance, cursor),
			);
			if (result.done) break;
			if (!result.cursor) throw new Error(`AI Search rebuild page ${page} did not return a cursor`);
			uploaded += result.uploaded;

			cursor = result.cursor;
			page++;
			console.info({
				tag: 'AI_SEARCH',
				msg: 'Index rebuild page complete',
				instance: event.payload.targetInstance,
				revision: event.payload.revision,
				page,
				cursor,
				uploaded,
			});
		}

		let deltaCursor: SearchDeltaCursor | null = null;
		let deltaPage = 0;
		let deltaUploaded = 0;
		while (true) {
			const result = await step.do(
				`sync-corpus-delta-page-${deltaPage}`,
				{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				() => syncCorpusDeltaAfter(this.env, event.payload.targetInstance, startedAt, deltaCursor),
			);
			if (result.done) break;
			if (!result.cursor) throw new Error(`AI Search delta page ${deltaPage} did not return a cursor`);
			deltaUploaded += result.uploaded;
			deltaCursor = result.cursor;
			deltaPage++;
		}
		const finalReconciliation = await reconcileSearchItems(this.env, step, event.payload.targetInstance, 'final');

		return {
			revision: event.payload.revision,
			targetInstance: event.payload.targetInstance,
			startedAt,
			instanceConfig,
			preReconciliation,
			uploaded,
			pages: page,
			startCursor,
			cursor,
			deltaUploaded,
			deltaPages: deltaPage,
			deltaCursor,
			finalReconciliation,
		};
	}
}
