// Read-context corpus readers (article / collection / url) moved here from the
// chat worker. Documents are NOT read here — they live in Vercel's domain and
// the chat worker reads them via the internal documents endpoint. The chat
// worker calls `readContextItems` via the CORE service binding; this returns one
// result per input item, in order, with an `error` entry for misses.

import { normalizeUrl } from '@shared/web';
import type { Client } from 'pg';
import { ARTICLE_COLS_FULL } from './search';

const CONTENT_MAX = 50000;
const SUMMARY_MAX = 500;
const COLLECTION_LIMIT = 100;
const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([a-zA-Z0-9_-]{11})/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RetrievalItemType = 'article' | 'collection' | 'url';
export interface ReadContextItem {
	type: RetrievalItemType;
	id: string;
}

export interface ReadContextResult {
	type: RetrievalItemType | 'document' | 'error';
	id: string;
	title?: string;
	content?: string;
	articles?: Array<{ id: string; title: string; summary: string | null }>;
	metadata?: Record<string, unknown>;
	error?: string;
}

interface ArticleRow {
	id: string;
	title: string;
	title_cn: string | null;
	url: string;
	published_date: Date | string | null;
	source: string | null;
	summary: string | null;
	summary_cn: string | null;
	content: string | null;
	content_cn: string | null;
	tags: string[] | null;
	source_type: string | null;
}

type TranscriptSegment = { startTime: number; endTime: number; text: string };
type TranscriptHighlight = { title: string; startTime: number; endTime: number; summary: string };

function isValidUuid(id: string): boolean {
	return UUID_RE.test(id);
}

function toMap<T, K>(rows: T[], key: (row: T) => K): Map<K, T> {
	return new Map(rows.map((r) => [key(r), r]));
}

function extractVideoId(url: string | null): string | null {
	return url?.match(YT_RE)?.[1] ?? null;
}

function truncate(content: string | null | undefined, max: number): string {
	if (!content) return '';
	return content.length > max ? `${content.slice(0, max)}\n\n[Content truncated]` : content;
}

function formatArticleResult(
	article: ArticleRow,
	transcript?: { segments: TranscriptSegment[]; highlights?: TranscriptHighlight[] } | null,
): ReadContextResult {
	const meta: Record<string, unknown> = {
		url: article.url,
		source: article.source,
		publishedDate: article.published_date,
		tags: article.tags,
	};
	if (transcript) {
		meta.videoId = extractVideoId(article.url);
		meta.transcript = transcript.segments;
		if (transcript.highlights) meta.aiHighlights = transcript.highlights;
	}
	return {
		type: 'article',
		id: article.id,
		title: article.title_cn || article.title,
		content: truncate(article.content_cn || article.content || article.summary_cn || article.summary, CONTENT_MAX),
		metadata: meta,
	};
}

async function attachTranscripts(client: Client, articles: ArticleRow[]): Promise<ReadContextResult[]> {
	const videoIds = articles
		.filter((a) => a.source_type === 'youtube')
		.map((a) => extractVideoId(a.url))
		.filter((v): v is string => !!v);

	let transcriptMap = new Map<string, { transcript: unknown; aiHighlights: unknown }>();
	if (videoIds.length > 0) {
		const result = await client.query<{ video_id: string; transcript: unknown; ai_highlights: unknown }>(
			`SELECT video_id, transcript, ai_highlights FROM youtube_transcripts WHERE video_id = ANY($1::text[])`,
			[videoIds],
		);
		transcriptMap = new Map(result.rows.map((r) => [r.video_id, { transcript: r.transcript, aiHighlights: r.ai_highlights }]));
	}

	return articles.map((a) => {
		const vid = a.source_type === 'youtube' ? extractVideoId(a.url) : null;
		const row = vid ? transcriptMap.get(vid) : null;
		const transcript = row
			? {
					segments: Array.isArray(row.transcript) ? (row.transcript as TranscriptSegment[]) : [],
					highlights: (row.aiHighlights as TranscriptHighlight[] | null) ?? undefined,
				}
			: null;
		return formatArticleResult(a, transcript);
	});
}

async function readArticles(client: Client, ids: string[]): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();
	const result = await client.query<ArticleRow>(`SELECT ${ARTICLE_COLS_FULL} FROM articles WHERE id = ANY($1::uuid[])`, [validIds]);
	const formatted = await attachTranscripts(client, result.rows);
	return new Map(formatted.map((r) => [r.id, r]));
}

async function readCollections(client: Client, ids: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();

	const [collectionsResult, citationsResult] = await Promise.all([
		client.query<{ id: string; name: string; description: string | null }>(
			`SELECT id, name, description FROM collections WHERE id = ANY($1::uuid[]) AND user_id = $2`,
			[validIds, userId],
		),
		client.query<{ from_id: string; to_id: string }>(
			`SELECT from_id, to_id FROM citations
			 WHERE user_id = $1 AND from_type = 'collection' AND from_id = ANY($2::text[]) AND to_type = 'article'`,
			[userId, validIds],
		),
	]);

	const articleIdsByCollection = new Map<string, string[]>();
	for (const row of citationsResult.rows) {
		const list = articleIdsByCollection.get(row.from_id) ?? [];
		if (list.length < COLLECTION_LIMIT) list.push(row.to_id);
		articleIdsByCollection.set(row.from_id, list);
	}

	const allArticleIds = [...new Set(citationsResult.rows.map((r) => r.to_id))];
	if (allArticleIds.length === 0) {
		return new Map(
			collectionsResult.rows.map((col) => [
				col.id,
				{
					type: 'collection' as const,
					id: col.id,
					title: col.name,
					content: col.description || undefined,
					articles: [],
					metadata: { articleCount: 0 },
				},
			]),
		);
	}

	const articlesResult = await client.query<{
		id: string;
		title: string;
		title_cn: string | null;
		summary: string | null;
		summary_cn: string | null;
	}>(`SELECT id, title, title_cn, summary, summary_cn FROM articles WHERE id = ANY($1::uuid[])`, [allArticleIds]);
	const articleMap = toMap(articlesResult.rows, (a) => a.id);

	return new Map(
		collectionsResult.rows.map((col) => {
			const colArticles = (articleIdsByCollection.get(col.id) ?? [])
				.map((aid) => articleMap.get(aid))
				.filter((a): a is NonNullable<typeof a> => !!a);
			return [
				col.id,
				{
					type: 'collection' as const,
					id: col.id,
					title: col.name,
					content: col.description || undefined,
					articles: colArticles.map((a) => {
						const summarySrc = a.summary_cn || a.summary;
						return {
							id: a.id,
							title: a.title_cn || a.title,
							summary: summarySrc ? truncate(summarySrc, SUMMARY_MAX) : null,
						};
					}),
					metadata: { articleCount: colArticles.length },
				},
			];
		}),
	);
}

async function readUrls(client: Client, urls: string[]): Promise<Map<string, ReadContextResult>> {
	const urlPairs = urls.map((u) => [u, normalizeUrl(u)] as const);
	const candidateUrls = [...new Set(urlPairs.flat())];

	const result = await client.query<ArticleRow>(`SELECT ${ARTICLE_COLS_FULL} FROM articles WHERE url = ANY($1::text[])`, [candidateUrls]);
	const dbMap = toMap(result.rows, (a) => a.url);
	const matches = urlPairs
		.map(([url, norm]) => ({ url, article: dbMap.get(url) ?? dbMap.get(norm) }))
		.filter((m): m is { url: string; article: ArticleRow } => !!m.article);

	const formatted = await attachTranscripts(
		client,
		matches.map((m) => m.article),
	);
	const formattedById = toMap(formatted, (r) => r.id);
	return new Map(matches.map((m) => [m.url, formattedById.get(m.article.id)!] as const));
}

type Reader = (client: Client, ids: string[], userId: string) => Promise<Map<string, ReadContextResult>>;

const READERS: Record<RetrievalItemType, Reader> = {
	article: (client, ids) => readArticles(client, ids),
	collection: readCollections,
	url: (client, ids) => readUrls(client, ids),
};

/**
 * Read a batch of article/collection/url items. Returns one result per input
 * item, in the same order, with an `error` entry for items that don't resolve —
 * the chat worker interleaves these with its document reads.
 */
export async function readContextItems(client: Client, items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
	const groups = new Map<RetrievalItemType, string[]>();
	for (const item of items) {
		const list = groups.get(item.type) ?? [];
		list.push(item.id);
		groups.set(item.type, list);
	}

	const resultMaps = new Map<RetrievalItemType, Map<string, ReadContextResult>>();
	await Promise.all(
		[...groups.entries()].map(async ([type, ids]) => {
			resultMaps.set(type, await READERS[type](client, ids, userId));
		}),
	);

	return items.map(
		(item) =>
			resultMaps.get(item.type)?.get(item.id) ?? { type: 'error' as const, id: item.id, error: `${item.type} not found: ${item.id}` },
	);
}
