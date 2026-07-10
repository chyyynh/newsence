import { type CoreDb, withCoreDb } from '@db/client';
import { isValidUuid, queryRows } from '@db/sql';
import { sql } from 'drizzle-orm';

const INSTANCE_NAME = 'newsence-corpus';
const ITEM_PREFIX = 'resources/';
const ITEM_SUFFIX = '.md';
const MAX_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_RESULTS = 50;

type CorpusDocumentRow = {
	id: string;
	type: string;
	url: string | null;
	original_lang: string;
	published_at: Date | string;
	tags: string[] | null;
	category: string | null;
	source: string | null;
	translations: Array<{
		lang: string;
		title: string | null;
		summary: string | null;
		content: string | null;
		keywords: string[] | null;
	}>;
};

export type AiSearchRank = { id: string; score: number };

export async function listCorpusIdsAfter(env: CoreEnv, cursor: string | null, limit = 50): Promise<string[]> {
	return withCoreDb(env, async (db) => {
		const rows = await queryRows<{ id: string }>(
			db,
			sql`
				SELECT id::text
				FROM resources
				WHERE scope = 'corpus'
				  AND enrichment_status = 'enriched'
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

function serializeDocument(row: CorpusDocumentRow): string {
	const header = [
		`# ${row.translations.find((translation) => translation.lang === row.original_lang)?.title ?? row.url ?? 'Untitled resource'}`,
		`URL: ${row.url ?? ''}`,
		`Type: ${row.type}`,
		`Published: ${new Date(row.published_at).toISOString()}`,
		row.tags?.length ? `Tags: ${row.tags.join(', ')}` : '',
	]
		.filter(Boolean)
		.join('\n');
	const translations = row.translations
		.map((translation) => {
			const keywords = translation.keywords?.length ? `\nKeywords: ${translation.keywords.join(', ')}\n` : '';
			return [
				`\n# Language: ${translation.lang}`,
				markdownSection('Title', translation.title),
				markdownSection('Summary', translation.summary),
				keywords,
				markdownSection('Content', translation.content),
			].join('');
		})
		.join('\n');
	const document = `${header}\n${translations}`;
	if (new TextEncoder().encode(document).byteLength <= MAX_ITEM_BYTES) return document;

	// Keep metadata and every translation's title/summary/keywords, then spend
	// the remaining byte budget on content in canonical language order.
	const compact = `${header}\n${row.translations
		.map(
			(translation) =>
				`\n# Language: ${translation.lang}${markdownSection('Title', translation.title)}${markdownSection('Summary', translation.summary)}${
					translation.keywords?.length ? `\nKeywords: ${translation.keywords.join(', ')}\n` : ''
				}`,
		)
		.join('\n')}`;
	const encoder = new TextEncoder();
	const remaining = Math.max(0, MAX_ITEM_BYTES - encoder.encode(compact).byteLength - 64);
	const originalContent = row.translations.find((translation) => translation.lang === row.original_lang)?.content ?? '';
	let content = originalContent.slice(0, remaining);
	while (content && encoder.encode(`${compact}\n## Content\n\n${content}`).byteLength > MAX_ITEM_BYTES) {
		content = content.slice(0, Math.floor(content.length * 0.9));
	}
	return `${compact}${markdownSection('Content', content)}`;
}

async function loadCorpusDocument(db: CoreDb, resourceId: string): Promise<CorpusDocumentRow | null> {
	const rows = await queryRows<CorpusDocumentRow>(
		db,
		sql`
			SELECT r.id::text,
			       r.type,
			       r.url,
			       r.original_lang,
			       COALESCE(r.published_date, r.scraped_date, r.created_at) AS published_at,
			       r.tags,
			       r.category,
			       COALESCE(r.platform_metadata->>'sourceName', r.type) AS source,
			       COALESCE(json_agg(json_build_object(
			         'lang', rt.lang,
			         'title', rt.title,
			         'summary', rt.summary,
			         'content', rt.content,
			         'keywords', rt.keywords
			       ) ORDER BY CASE WHEN rt.lang = r.original_lang THEN 0 ELSE 1 END, rt.lang)
			       FILTER (WHERE rt.resource_id IS NOT NULL), '[]'::json) AS translations
			FROM resources r
			LEFT JOIN resource_translations rt ON rt.resource_id = r.id
			WHERE r.id = ${resourceId}::uuid
			  AND r.scope = 'corpus'
			  AND r.enrichment_status = 'enriched'
			GROUP BY r.id
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
	const result = await env.AI_SEARCH.get(INSTANCE_NAME).items.upload(itemKey(resourceId), serializeDocument(document), {
		metadata: {
			published_at: new Date(document.published_at).toISOString(),
			language: document.original_lang,
			source: document.source ?? document.type,
			type: document.type,
			category: document.category ?? '',
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
	const listed = await env.AI_SEARCH.get(INSTANCE_NAME).items.list({ search: key, per_page: 10 });
	const matches = listed.result.filter((item) => item.key === key);
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
		scores.set(id, Math.max(scores.get(id) ?? 0, chunk.score));
	}
	return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
