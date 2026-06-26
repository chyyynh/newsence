import { createDbClient } from '@shared/db';
import { generateArticleEmbedding } from '@shared/embedding';
import type { Env } from '@shared/types';
import { normalizeUrl } from '@shared/web';
import type { Client } from 'pg';

type SearchRanks = Map<string, number>;
type ResourceType = 'article' | 'collection' | 'url';

export interface ArticleSummary {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	source?: string | null;
	summary?: string;
	tags?: string[] | null;
}

export interface CorpusReadItem {
	type: ResourceType;
	id: string;
}

export interface CorpusReadResult {
	type: ResourceType | 'document' | 'error';
	id: string;
	title?: string;
	content?: string;
	articles?: Array<{ id: string; title: string; summary: string | null }>;
	metadata?: Record<string, unknown>;
	error?: string;
}

interface ArticleSummaryRow {
	id: string;
	title: string;
	title_cn: string | null;
	url: string;
	published_date: Date | string | null;
	source: string | null;
	summary: string | null;
	summary_cn: string | null;
	tags: string[] | null;
}

interface ArticleContentRow extends ArticleSummaryRow {
	content: string | null;
	content_cn: string | null;
	source_type: string | null;
}

type TranscriptSegment = { startTime: number; endTime: number; text: string };
type TranscriptHighlight = { title: string; startTime: number; endTime: number; summary: string };
type Reader = (client: Client, ids: string[], userId: string) => Promise<Map<string, CorpusReadResult>>;

const ARTICLE_SUMMARY_COLS = 'id, title, title_cn, url, published_date, source, summary, summary_cn, tags';
const ARTICLE_CONTENT_COLS = `${ARTICLE_SUMMARY_COLS}, content, content_cn, source_type`;
const EMPTY_RANKS: SearchRanks = new Map();
const SEARCH_LIMIT = 200;
const RESULT_LIMIT = 10;
const SUMMARY_MAX = 500;
const CONTENT_MAX = 50000;
const COLLECTION_LIMIT = 100;
const RRF_K = 60;
const RECENCY_HALF_LIFE_DAYS = 30;
const OVERFETCH_MULTIPLIER = 5;
const OVERFETCH_CAP = 200;
const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([a-zA-Z0-9_-]{11})/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function rankCorpusArticleIds(env: Env, query: string, limit = 100): Promise<Array<{ id: string; score: number }>> {
	return withDb(env, async (client) => {
		const ranks = await rankArticles(client, env, query, limit);
		return [...ranks].map(([id, score]) => ({ id, score }));
	});
}

export async function relatedCorpusArticleIds(
	env: Env,
	seed: { id: string; type: 'article' | 'user_file' },
	limit: number,
	offset: number,
): Promise<string[]> {
	return withDb(env, (client) => relatedArticles(client, seed, limit, offset));
}

export async function searchCorpusArticles(
	env: Env,
	query: string,
	opts?: { daysAgo?: number; limit?: number },
): Promise<ArticleSummary[]> {
	const limit = opts?.limit ?? RESULT_LIMIT;
	return withDb(env, async (client) => {
		const trimmed = query.trim();
		const ranks = trimmed ? await rankArticles(client, env, trimmed, SEARCH_LIMIT) : null;
		const fromDate = opts?.daysAgo ? new Date(Date.now() - opts.daysAgo * 86_400_000) : null;

		if (ranks) {
			if (ranks.size === 0) return [];
			const candidateIds = [...ranks.keys()].filter(isValidUuid).slice(0, limit);
			if (candidateIds.length === 0) return [];
			const params: unknown[] = [candidateIds];
			let where = `id = ANY($1::uuid[])`;
			if (fromDate) {
				params.push(fromDate);
				where += ` AND published_date >= $${params.length}`;
			}
			const result = await client.query<ArticleSummaryRow>(`SELECT ${ARTICLE_SUMMARY_COLS} FROM articles WHERE ${where}`, params);
			return sortByRank(result.rows, ranks).map(formatSummary);
		}

		const params: unknown[] = [];
		let where = 'TRUE';
		if (fromDate) {
			params.push(fromDate);
			where = `published_date >= $${params.length}`;
		}
		params.push(limit);
		const result = await client.query<ArticleSummaryRow>(
			`SELECT ${ARTICLE_SUMMARY_COLS} FROM articles WHERE ${where} ORDER BY published_date DESC LIMIT $${params.length}`,
			params,
		);
		return result.rows.map(formatSummary);
	});
}

export async function readCorpusItems(env: Env, items: CorpusReadItem[], userId: string): Promise<CorpusReadResult[]> {
	return withDb(env, (client) => readItems(client, items, userId));
}

async function withDb<T>(env: Env, fn: (client: Client) => Promise<T>): Promise<T> {
	const client = await createDbClient(env);
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

function toIsoString(value: Date | string | null): string | undefined {
	if (value === null) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatSummary(a: ArticleSummaryRow): ArticleSummary {
	const summary = a.summary_cn ?? a.summary ?? undefined;
	return {
		id: a.id,
		title: a.title_cn || a.title,
		url: a.url,
		publishedDate: toIsoString(a.published_date),
		source: a.source ?? undefined,
		summary: summary ? summary.slice(0, SUMMARY_MAX) : undefined,
		tags: a.tags ?? undefined,
	};
}

function sortByRank<T extends { id: string }>(articles: T[], ranks: SearchRanks): T[] {
	return [...articles].sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0));
}

async function relatedArticles(
	client: Client,
	seed: { id: string; type: 'article' | 'user_file' },
	limit: number,
	offset: number,
): Promise<string[]> {
	if (!isValidUuid(seed.id)) return [];
	const seedTable = seed.type === 'user_file' ? 'user_files' : 'articles';
	const rows = await client.query<{ id: string }>(
		`WITH src AS (
			SELECT embedding FROM ${seedTable} WHERE id = $1::uuid AND embedding IS NOT NULL LIMIT 1
		)
		SELECT a.id
		FROM articles a, src
		WHERE a.id <> $1::uuid AND a.embedding IS NOT NULL
		ORDER BY a.embedding <=> src.embedding
		LIMIT $2 OFFSET $3`,
		[seed.id, limit, offset],
	);
	return rows.rows.map((r) => r.id);
}

async function rankArticles(client: Client, env: Env, query: string, limit = 100): Promise<SearchRanks> {
	const sanitized = sanitize(query);
	if (!sanitized) return EMPTY_RANKS;

	const tokens = tokenize(sanitized);
	const patterns = tokens.length > 0 ? tokens.map((t) => `%${t}%`) : [`%${sanitized}%`];

	const embedding = await generateArticleEmbedding(sanitized, env.AI).catch(() => null);
	if (!embedding) return keywordOnly(client, patterns, limit);
	const vectorStr = `[${embedding.join(',')}]`;

	try {
		const result = await client.query<{ id: string; score: number | string }>(
			`
			WITH vec AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
				FROM articles
				WHERE embedding IS NOT NULL
				ORDER BY embedding <=> $1::vector
				LIMIT $2
			),
			kw AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY published_date DESC NULLS LAST) AS rank
				FROM articles
				WHERE EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ILIKE ANY($3::text[]))
				   OR title ILIKE ANY($3::text[])
				   OR title_cn ILIKE ANY($3::text[])
				LIMIT $2
			),
			fused AS (
				SELECT id, 1.0 / ($4 + rank) AS score FROM vec
				UNION ALL
				SELECT id, 1.0 / ($4 + rank) AS score FROM kw
			),
			scored AS (
				SELECT id, SUM(score) AS s FROM fused GROUP BY id
			)
			SELECT
				s.id::text,
				s.s * (1.0 / (1 + EXTRACT(EPOCH FROM now() - a.published_date) / 86400.0 / $5)) AS score
			FROM scored s
			JOIN articles a ON s.id = a.id
			ORDER BY score DESC
			LIMIT $6
			`,
			[vectorStr, Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP), patterns, RRF_K, RECENCY_HALF_LIFE_DAYS, limit],
		);
		return new Map(result.rows.map((r) => [r.id, Number(r.score)]));
	} catch (error) {
		console.warn({ tag: 'CORPUS', msg: 'hybrid query failed, falling back to keyword search', error: String(error) });
		return keywordOnly(client, patterns, limit);
	}
}

async function keywordOnly(client: Client, patterns: string[], limit: number): Promise<SearchRanks> {
	try {
		const result = await client.query<{ id: string; match_count: number | string }>(
			`
			SELECT id,
				(SELECT COUNT(*) FROM unnest(keywords) k WHERE k ILIKE ANY($1::text[])) AS match_count
			FROM articles
			WHERE EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ILIKE ANY($1::text[]))
			   OR title ILIKE ANY($1::text[])
			   OR title_cn ILIKE ANY($1::text[])
			ORDER BY match_count DESC, published_date DESC NULLS LAST
			LIMIT $2
			`,
			[patterns, limit],
		);
		const max = Math.max(...result.rows.map((r) => Number(r.match_count)), 1);
		return new Map(result.rows.map((r) => [r.id, Number(r.match_count) / max]));
	} catch (error) {
		console.warn({ tag: 'CORPUS', msg: 'keyword fallback failed', error: String(error) });
		return EMPTY_RANKS;
	}
}

function sanitize(query: string, maxLength = 200): string {
	return query
		.trim()
		.replace(/['"\\;!&|():<>]/g, ' ')
		.replace(/\s+/g, ' ')
		.slice(0, maxLength);
}

function tokenize(sanitized: string): string[] {
	const parts = sanitized.split(/[\s,，、。.;；!！?？/\\|]+/).filter(Boolean);
	const tokens = new Set<string>();
	for (const p of parts) {
		if (/[㐀-鿿぀-ヿ]/.test(p) || p.length >= 2) {
			tokens.add(p);
		}
	}
	return [...tokens].slice(0, 8);
}

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

function formatArticleReadResult(
	article: ArticleContentRow,
	transcript?: { segments: TranscriptSegment[]; highlights?: TranscriptHighlight[] } | null,
): CorpusReadResult {
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
		title: article.title,
		content: truncate(article.content || article.summary || article.content_cn || article.summary_cn, CONTENT_MAX),
		metadata: meta,
	};
}

async function attachTranscripts(client: Client, articles: ArticleContentRow[]): Promise<CorpusReadResult[]> {
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
		return formatArticleReadResult(a, transcript);
	});
}

async function readArticles(client: Client, ids: string[]): Promise<Map<string, CorpusReadResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();
	const result = await client.query<ArticleContentRow>(`SELECT ${ARTICLE_CONTENT_COLS} FROM articles WHERE id = ANY($1::uuid[])`, [
		validIds,
	]);
	const formatted = await attachTranscripts(client, result.rows);
	return new Map(formatted.map((r) => [r.id, r]));
}

async function readCollections(client: Client, ids: string[], userId: string): Promise<Map<string, CorpusReadResult>> {
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

	const allArticleIds = [...new Set(citationsResult.rows.map((r) => r.to_id).filter(isValidUuid))];
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
						const summarySrc = a.summary || a.summary_cn;
						return {
							id: a.id,
							title: a.title,
							summary: summarySrc ? truncate(summarySrc, SUMMARY_MAX) : null,
						};
					}),
					metadata: { articleCount: colArticles.length },
				},
			];
		}),
	);
}

async function readUrls(client: Client, urls: string[]): Promise<Map<string, CorpusReadResult>> {
	const urlPairs = urls.map((u) => [u, normalizeUrl(u)] as const);
	const candidateUrls = [...new Set(urlPairs.flat())];

	const result = await client.query<ArticleContentRow>(`SELECT ${ARTICLE_CONTENT_COLS} FROM articles WHERE url = ANY($1::text[])`, [
		candidateUrls,
	]);
	const dbMap = toMap(result.rows, (a) => a.url);
	const matches = urlPairs
		.map(([url, norm]) => ({ url, article: dbMap.get(url) ?? dbMap.get(norm) }))
		.filter((m): m is { url: string; article: ArticleContentRow } => !!m.article);

	const formatted = await attachTranscripts(
		client,
		matches.map((m) => m.article),
	);
	const formattedById = toMap(formatted, (r) => r.id);
	return new Map(matches.map((m) => [m.url, formattedById.get(m.article.id)!] as const));
}

const READERS: Record<ResourceType, Reader> = {
	article: (client, ids) => readArticles(client, ids),
	collection: readCollections,
	url: (client, ids) => readUrls(client, ids),
};

async function readItems(client: Client, items: CorpusReadItem[], userId: string): Promise<CorpusReadResult[]> {
	const groups = new Map<ResourceType, string[]>();
	for (const item of items) {
		const list = groups.get(item.type) ?? [];
		list.push(item.id);
		groups.set(item.type, list);
	}

	const resultMaps = new Map<ResourceType, Map<string, CorpusReadResult>>();
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
