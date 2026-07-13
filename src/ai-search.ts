import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { CONTENT_RESOURCE_TYPES } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { isValidUuid, queryRows, textArraySql, uuidArraySql } from '@db/sql';
import { sql } from 'drizzle-orm';
import { enqueueOrRestartWorkflow } from './workflow-control';

const INSTANCE_NAME = 'newsence-corpus';
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
	type: string;
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
	fromDate?: Date | null;
	profile?: CorpusSearchProfile;
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

function documentPublishedAt(row: CorpusDocument): string | undefined {
	if (row.published_at === null) return undefined;
	const date = new Date(row.published_at);
	if (Number.isNaN(date.getTime())) throw new Error(`AI Search document ${row.id} has invalid published_at`);
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

async function loadCorpusDocument(db: CoreDb, resourceId: string): Promise<CorpusDocument | null> {
	const rows = await queryRows<CorpusDocument>(
		db,
		sql`
				SELECT r.id::text,
				       r.type,
				       r.original_lang,
				       COALESCE(r.published_date, r.scraped_date, r.created_at) AS published_at,
				       r.tags,
				       r.category,
				       COALESCE(NULLIF(r.platform_metadata->>'sourceName', ''), r.type) AS source,
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
				WHERE r.id = ${resourceId}::uuid
					  AND r.scope = 'corpus'
					  AND r.enrichment_status = 'enriched'
					  AND r.type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
			`,
	);
	return rows[0] ?? null;
}

export async function syncCorpusItem(env: CoreEnv, resourceId: string): Promise<'uploaded' | 'deleted' | 'skipped'> {
	if (!isValidUuid(resourceId)) return 'skipped';
	const document = await withCoreDb(env, (db) => loadCorpusDocument(db, resourceId));
	if (!document) {
		await deleteCorpusItem(env, resourceId);
		return 'deleted';
	}
	const startedAt = Date.now();
	const publishedAt = documentPublishedAt(document);
	const source = requiredDocumentText(document.source, 'source', document.id);
	const result = await env.AI_SEARCH.get(INSTANCE_NAME).items.upload(itemKey(resourceId), serializeDocument(document), {
		metadata: {
			...(publishedAt ? { published_at: publishedAt } : {}),
			language: document.original_lang,
			source,
			type: document.type,
			...(document.category ? { category: document.category } : {}),
		},
	});
	console.info({
		tag: 'AI_SEARCH',
		msg: 'Corpus item queued',
		resource_id: resourceId,
		item_id: result.id,
		latency_ms: Date.now() - startedAt,
	});
	return 'uploaded';
}

export async function deleteCorpusItem(env: CoreEnv, resourceId: string): Promise<boolean> {
	const key = itemKey(resourceId);
	// Exact-key filtering shipped on 2026-07-08; the Workers binding type has
	// not caught up with the documented `key` parameter yet.
	const listed = await env.AI_SEARCH.get(INSTANCE_NAME).items.list({ key, source: 'builtin', per_page: 1 } as AiSearchListItemsParams & {
		key: string;
	});
	const matches = listed.result.filter((item) => item.key === key && item.source_id === 'builtin');
	await Promise.all(matches.map((item) => env.AI_SEARCH.get(INSTANCE_NAME).items.delete(item.id)));
	if (matches.length) console.info({ tag: 'AI_SEARCH', msg: 'Corpus item deleted', resource_id: resourceId, count: matches.length });
	return matches.length > 0;
}

export async function searchCorpusRanks(env: CoreEnv, query: string, options: CorpusSearchOptions = {}): Promise<AiSearchRank[]> {
	const profile = options.profile ?? 'discovery';
	const retrievalType = profile === 'related' ? 'vector' : 'hybrid';
	const response = await env.AI_SEARCH.get(INSTANCE_NAME).search({
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
				...(profile === 'related' ? {} : { boost_by: [{ field: 'published_at', direction: 'desc' as const }] }),
				...(options.fromDate ? { filters: { published_at: { $gte: options.fromDate.toISOString() } } } : {}),
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

type SearchIndexRebuildPayload = { revision: string };

const SEARCH_INDEX_REVISION = 'v4';
const REINDEX_PAGE_SIZE = 50;
const REINDEX_UPLOAD_CONCURRENCY = 10;
const REINDEX_DELETE_CONCURRENCY = 10;
const REINDEX_MAX_PRUNE_PASSES = 3;

type SearchItemPageAudit = {
	deleted: number;
	scanned: number;
};

async function loadSearchItemPageCount(env: CoreEnv): Promise<number> {
	const listed = await env.AI_SEARCH.get(INSTANCE_NAME).items.list({
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

async function pruneSearchItemPage(env: CoreEnv, page: number): Promise<SearchItemPageAudit> {
	const instance = env.AI_SEARCH.get(INSTANCE_NAME);
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
		console.info({ tag: 'AI_SEARCH', msg: 'Stale corpus items deleted', page, count: staleItems.length });
	}
	return { deleted: staleItems.length, scanned: listed.result.length };
}

async function ensureSearchInstanceConfig(env: CoreEnv): Promise<'unchanged' | 'updated'> {
	const instance = env.AI_SEARCH.get(INSTANCE_NAME);
	const info = await instance.info();
	if (
		info.index_method?.vector === true &&
		info.index_method.keyword === true &&
		info.fusion_method === 'rrf' &&
		info.indexing_options?.keyword_tokenizer === 'trigram'
	) {
		return 'unchanged';
	}
	await instance.update({
		index_method: { vector: true, keyword: true },
		fusion_method: 'rrf',
		indexing_options: { keyword_tokenizer: 'trigram' },
	});
	return 'updated';
}

export function startSearchIndexRebuild(env: CoreEnv): Promise<string> {
	return enqueueOrRestartWorkflow(env.SEARCH_INDEX_REBUILD_WORKFLOW, `search-index-rebuild-${SEARCH_INDEX_REVISION}`, {
		revision: SEARCH_INDEX_REVISION,
	});
}

export class SearchIndexRebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
		let deleted = 0;
		let scanned = 0;
		let prunePasses = 0;
		while (prunePasses < REINDEX_MAX_PRUNE_PASSES) {
			const itemPageCount = await step.do(
				`load-search-item-page-count-${prunePasses}`,
				{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				() => loadSearchItemPageCount(this.env),
			);
			let passDeleted = 0;
			// Deleting from the last page first prevents ordinary pagination
			// shifts from skipping items. Repeating until a zero-delete pass also
			// covers undocumented tie ordering and concurrent item movement.
			for (let itemPage = itemPageCount; itemPage >= 1; itemPage--) {
				const audit = await step.do(
					`prune-search-item-page-${prunePasses}-${itemPage}`,
					{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
					() => pruneSearchItemPage(this.env, itemPage),
				);
				passDeleted += audit.deleted;
				scanned += audit.scanned;
			}
			deleted += passDeleted;
			prunePasses++;
			if (passDeleted === 0) break;
			if (prunePasses === REINDEX_MAX_PRUNE_PASSES) {
				throw new Error(`AI Search stale-item reconciliation did not converge after ${prunePasses} passes`);
			}
		}

		const instanceConfig = await step.do(
			'ensure-search-instance-config',
			{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
			() => ensureSearchInstanceConfig(this.env),
		);
		let cursor: string | null = null;
		let uploaded = 0;
		let page = 0;

		while (true) {
			const ids = await step.do(
				`load-corpus-page-${page}`,
				{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				() => listCorpusIdsAfter(this.env, cursor, REINDEX_PAGE_SIZE),
			);
			if (!ids.length) break;

			const pageUploaded = await step.do(
				`upload-corpus-page-${page}`,
				{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				async () => {
					let count = 0;
					for (let offset = 0; offset < ids.length; offset += REINDEX_UPLOAD_CONCURRENCY) {
						const batch = ids.slice(offset, offset + REINDEX_UPLOAD_CONCURRENCY);
						const synced = await Promise.all(batch.map((id) => syncCorpusItem(this.env, id)));
						count += synced.filter((result) => result === 'uploaded').length;
					}
					return count;
				},
			);
			uploaded += pageUploaded;

			cursor = ids.at(-1)!;
			page++;
			console.info({ tag: 'AI_SEARCH', msg: 'Index rebuild page complete', revision: event.payload.revision, page, cursor, uploaded });
		}

		return { revision: event.payload.revision, instanceConfig, prunePasses, scanned, deleted, uploaded, pages: page, cursor };
	}
}
