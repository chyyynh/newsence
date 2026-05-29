// Mirrors frontend/src/lib/ai/tools/read-context.ts. Four readers
// (document / collection / article / url) with YouTube transcripts joined
// for source_type='youtube' articles.

import { withClient } from '@shared/db/client';
import { isValidUuid, toMap } from '@shared/ids';
import type { Env } from '@shared/types';
import { normalizeUrl } from '@shared/web';
import { tool } from 'ai';
import type { Client } from 'pg';
import { z } from 'zod';
import { contentToMarkdown } from '../editor/serverEditor';
import { ARTICLE_COLS_FULL } from '../search/articles';

const CONTENT_MAX = 50000;
const SUMMARY_MAX = 500;
const COLLECTION_LIMIT = 100;
const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([a-zA-Z0-9_-]{11})/;

const schema = z.object({
	items: z
		.array(
			z.object({
				type: z
					.enum(['document', 'collection', 'article', 'url'])
					.describe('Resource type: document/collection/article by ID, or url by URL'),
				id: z.string().describe('Resource ID (UUID) or full URL when type is "url"'),
			}),
		)
		.min(1)
		.max(10)
		.describe('Array of resources to read (up to 10)'),
});

type ItemType = z.infer<typeof schema>['items'][number]['type'];

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

interface ReadContextResult {
	type: ItemType;
	id: string;
	title: string;
	content?: string;
	articles?: Array<{ id: string; title: string; summary: string | null }>;
	metadata?: Record<string, unknown>;
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

	// Single batched citation lookup keyed on from_id ∈ collections. Previously
	// this fanned out one query per collection (N+1) — now grouped client-side
	// after one round-trip, then LIMITed per collection in JS.
	const [collectionsResult, citationsResult] = await Promise.all([
		client.query<{ id: string; name: string; description: string | null }>(
			`SELECT id, name, description FROM collections WHERE id = ANY($1::uuid[]) AND user_id = $2`,
			[validIds, userId],
		),
		client.query<{ from_id: string; to_id: string }>(
			// from_id is a text column (citations are polymorphic), so compare as
			// text[] — validIds are already uuid-validated strings, so the match is
			// exact. (collections.id above is a real uuid column, hence ::uuid[].)
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

async function readDocuments(client: Client, ids: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();

	const result = await client.query<{
		id: string;
		title: string;
		content: unknown;
		created_at: Date | string;
		updated_at: Date | string;
	}>(`SELECT id, title, content, created_at, updated_at FROM user_documents WHERE id = ANY($1::uuid[]) AND user_id = $2`, [
		validIds,
		userId,
	]);

	return new Map(
		result.rows.map((d) => [
			d.id,
			{
				type: 'document' as const,
				id: d.id,
				title: d.title,
				content: truncate(contentToMarkdown(d.content), CONTENT_MAX),
				metadata: { createdAt: d.created_at, updatedAt: d.updated_at },
			},
		]),
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

const READERS: Record<ItemType, Reader> = {
	article: (client, ids) => readArticles(client, ids),
	collection: readCollections,
	document: readDocuments,
	url: (client, ids) => readUrls(client, ids),
};

export function createReadContextTool(env: Env, userId: string) {
	return tool({
		description:
			'Read the content of one or more resources in a single call. Pass an `items` array. Use for: ' +
			'(1) attached resources listed in "Attached Resources" — batch ALL items into one call; ' +
			'(2) any URLs the user shares — include as { type: "url", id: "<URL>" }. ' +
			'Up to 10 items per call.',
		inputSchema: schema,
		execute: async ({ items }) => {
			const groups = new Map<ItemType, string[]>();
			for (const item of items) {
				const list = groups.get(item.type) ?? [];
				list.push(item.id);
				groups.set(item.type, list);
			}

			return withClient(env, async (client) => {
				const resultMaps = new Map<ItemType, Map<string, ReadContextResult>>();
				await Promise.all(
					[...groups.entries()].map(async ([type, ids]) => {
						resultMaps.set(type, await READERS[type](client, ids, userId));
					}),
				);

				return items.map((item) => {
					const result = resultMaps.get(item.type)?.get(item.id);
					return result ?? { type: 'error' as const, id: item.id, error: `${item.type} not found: ${item.id}` };
				});
			});
		},
	});
}
