import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { CONTENT_RESOURCE_TYPES } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { isValidUuid, queryRows, textArraySql } from '@db/sql';
import { sql } from 'drizzle-orm';
import { enqueueOrRestartWorkflow } from './workflow-control';

const INSTANCE_NAME = 'newsence-corpus';
const ITEM_PREFIX = 'resources/';
const ITEM_SUFFIX = '.md';
const CONTENT_MAX_CHARS = 8_000;
const MAX_RESULTS = 50;

type CorpusDocumentRow = {
	id: string;
	type: string;
	original_lang: string;
	published_at: Date | string | null;
	tags: string[] | null;
	category: string | null;
	source: string | null;
	title: string | null;
	summary: string | null;
	content: string | null;
	keywords: string[] | null;
};

type AiSearchRank = { id: string; score: number };

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

function documentPublishedAt(row: CorpusDocumentRow): string {
	if (!row.published_at) throw new Error(`AI Search document ${row.id} is missing published_at`);
	const date = new Date(row.published_at);
	if (Number.isNaN(date.getTime())) throw new Error(`AI Search document ${row.id} has invalid published_at`);
	return date.toISOString();
}

function serializeDocument(row: CorpusDocumentRow): string {
	const title = requiredDocumentText(row.title, 'title', row.id);
	const source = requiredDocumentText(row.source, 'source', row.id);
	return [
		`# ${title}`,
		source,
		row.tags?.length ? `Tags: ${row.tags.join(', ')}` : '',
		row.keywords?.length ? `Keywords: ${row.keywords.join(', ')}` : '',
		markdownSection('Summary', row.summary),
		markdownSection('Content', row.content?.slice(0, CONTENT_MAX_CHARS)),
	]
		.filter(Boolean)
		.join('\n\n');
}

async function loadCorpusDocument(db: CoreDb, resourceId: string): Promise<CorpusDocumentRow | null> {
	const rows = await queryRows<CorpusDocumentRow>(
		db,
		sql`
				SELECT r.id::text,
				       r.type,
				       r.original_lang,
				       r.published_date AS published_at,
				       r.tags,
				       r.category,
				       NULLIF(r.platform_metadata->>'sourceName', '') AS source,
				       rt.title,
				       rt.summary,
				       rt.content,
				       rt.keywords
				FROM resources r
				JOIN resource_translations rt
				  ON rt.resource_id = r.id
				 AND rt.lang = r.original_lang
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
			published_at: publishedAt,
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
	// Exact-key filtering landed in AI Search before the Workers type definition.
	const listed = await env.AI_SEARCH.get(INSTANCE_NAME).items.list({ key, source: 'builtin', per_page: 1 } as AiSearchListItemsParams & {
		key: string;
	});
	const matches = listed.result.filter((item) => item.key === key && item.source_id === 'builtin');
	await Promise.all(matches.map((item) => env.AI_SEARCH.get(INSTANCE_NAME).items.delete(item.id)));
	if (matches.length) console.info({ tag: 'AI_SEARCH', msg: 'Corpus item deleted', resource_id: resourceId, count: matches.length });
	return matches.length > 0;
}

export async function searchCorpusRanks(env: CoreEnv, query: string, fromDate?: Date | null): Promise<AiSearchRank[]> {
	const response = await env.AI_SEARCH.get(INSTANCE_NAME).search({
		query,
		ai_search_options: {
			query_rewrite: { enabled: false },
			reranking: { enabled: false },
			retrieval: {
				retrieval_type: 'hybrid',
				fusion_method: 'rrf',
				keyword_match_mode: 'or',
				max_num_results: MAX_RESULTS,
				return_on_failure: false,
				boost_by: [{ field: 'published_at', direction: 'desc' }],
				...(fromDate ? { filters: { published_at: { $gte: fromDate.toISOString() } } } : {}),
			},
		},
	});
	const scores = new Map<string, number>();
	for (const chunk of response.chunks) {
		const id = idFromItemKey(chunk.item.key);
		if (!id) continue;
		const previousScore = scores.get(id);
		scores.set(id, previousScore === undefined ? chunk.score : Math.max(previousScore, chunk.score));
	}
	return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

type SearchIndexRebuildPayload = { revision: string };

const SEARCH_INDEX_REVISION = 'v2';
const REINDEX_PAGE_SIZE = 50;
const REINDEX_UPLOAD_CONCURRENCY = 10;

export function startSearchIndexRebuild(env: CoreEnv): Promise<string> {
	return enqueueOrRestartWorkflow(env.SEARCH_INDEX_REBUILD_WORKFLOW, `search-index-rebuild-${SEARCH_INDEX_REVISION}`, {
		revision: SEARCH_INDEX_REVISION,
	});
}

export class SearchIndexRebuildWorkflow extends WorkflowEntrypoint<CoreEnv, SearchIndexRebuildPayload> {
	async run(event: WorkflowEvent<SearchIndexRebuildPayload>, step: WorkflowStep) {
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

		return { revision: event.payload.revision, uploaded, pages: page, cursor };
	}
}
