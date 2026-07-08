import { generateArticleEmbedding } from '@core-ai/embedding';
import type { TranscriptSegment } from '@core-shared/types';
import { normalizeUrl } from '@core-shared/web';
import type { Client } from 'pg';
import { Client as PgClient } from 'pg';

export interface ArticleSummary {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	source?: string | null;
	summary?: string;
	tags?: string[] | null;
}

export type ArticleSearchInput = {
	query: string;
	daysAgo?: number;
	limit?: number;
};

export type ArticleRankSearchInput = {
	query: string;
	limit?: number;
};

export type RelatedArticleSearchInput = {
	seed: { id: string; type: 'article' | 'user_file' };
	limit?: number;
	offset?: number;
};

export interface ReadContextItem {
	type: 'article' | 'collection' | 'user_file' | 'url';
	id: string;
}

export interface ReadContextResult {
	type: 'article' | 'collection' | 'user_file' | 'url' | 'document' | 'error';
	id: string;
	title?: string;
	content?: string;
	articles?: Array<{ id: string; title: string; summary: string | null }>;
	metadata?: Record<string, unknown>;
	error?: string;
}

type SearchRanks = Map<string, number>;
type ResourceType = ReadContextItem['type'];
type RankArticleOptions = { fromDate?: Date | null };

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

interface UserFileContentRow {
	id: string;
	file_name: string;
	file_type: string;
	resource_kind: string;
	title: string | null;
	title_cn: string | null;
	source_url: string | null;
	normalized_source_url: string | null;
	site_name: string | null;
	platform_type: string | null;
	published_date: Date | string | null;
	summary: string | null;
	summary_cn: string | null;
	extracted_text: string | null;
	content_cn: string | null;
	tags: string[] | null;
}

type TranscriptHighlight = { title: string; startTime: number; endTime: number; summary: string };

const ARTICLE_SUMMARY_COLS = 'id, title, title_cn, url, published_date, source, summary, summary_cn, tags';
const ARTICLE_CONTENT_COLS = `${ARTICLE_SUMMARY_COLS}, content, content_cn, source_type`;
const EMPTY_RANKS: SearchRanks = new Map();
const SEARCH_LIMIT = 200;
const SEARCH_RANK_LIMIT_MAX = 500;
const RESULT_LIMIT = 10;
const RESULT_LIMIT_MAX = 50;
const RELATED_LIMIT_DEFAULT = 12;
const RELATED_LIMIT_MAX = 500;
const SEARCH_RANK_BUFFER_MULTIPLIER = 4;
const SEARCH_RANK_BUFFER_MIN = 40;
const SUMMARY_MAX = 500;
const CONTENT_MAX = 50000;
const READ_CONTEXT_TOTAL_CONTENT_MAX = 60000;
const READ_CONTEXT_MIN_ITEM_CONTENT_MAX = 4000;
const COLLECTION_LIMIT = 100;
const RRF_K = 60;
const RECENCY_HALF_LIFE_DAYS = 30;
const OVERFETCH_MULTIPLIER = 5;
const OVERFETCH_CAP = 200;
const YT_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([a-zA-Z0-9_-]{11})/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function searchCorpusArticleRanks(env: CoreEnv, input: ArticleRankSearchInput): Promise<Array<{ id: string; score: number }>> {
	const query = input.query.trim();
	if (!query) return [];
	const limit = clampInt(input.limit, 1, SEARCH_RANK_LIMIT_MAX, 100);
	const client = new PgClient({ connectionString: env.HYPERDRIVE.connectionString });
	try {
		await client.connect();
		const ranks = await rankArticles(client, env, query, limit);
		return [...ranks].map(([id, score]) => ({ id, score }));
	} finally {
		await closeCorpusClient(client);
	}
}

export async function relatedCorpusArticleIds(env: CoreEnv, input: RelatedArticleSearchInput): Promise<string[]> {
	const seed = { id: input.seed.id.trim(), type: input.seed.type };
	if (!seed.id) return [];
	const limit = clampInt(input.limit, 1, RELATED_LIMIT_MAX, RELATED_LIMIT_DEFAULT);
	const offset = clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
	const client = new PgClient({ connectionString: env.HYPERDRIVE.connectionString });
	try {
		await client.connect();
		const ids = await relatedArticles(client, seed, limit, offset);
		return [...new Set(ids)].filter((id) => id !== seed.id);
	} finally {
		await closeCorpusClient(client);
	}
}

export async function searchCorpusArticles(env: CoreEnv, input: ArticleSearchInput): Promise<ArticleSummary[]> {
	const query = input.query.trim();
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT);
	const client = new PgClient({ connectionString: env.HYPERDRIVE.connectionString });
	try {
		await client.connect();
		const fromDate = input.daysAgo ? new Date(Date.now() - input.daysAgo * 86_400_000) : null;
		const rankLimit = Math.min(SEARCH_LIMIT, Math.max(limit * SEARCH_RANK_BUFFER_MULTIPLIER, SEARCH_RANK_BUFFER_MIN));
		const ranks = query ? await rankArticles(client, env, query, rankLimit, { fromDate }) : null;

		if (ranks) {
			if (ranks.size === 0) return [];
			const candidateIds = [...ranks.keys()].filter(isValidUuid);
			if (candidateIds.length === 0) return [];
			const params: unknown[] = [candidateIds];
			let where = `id = ANY($1::uuid[])`;
			if (fromDate) {
				params.push(fromDate);
				where += ` AND published_date >= $${params.length}`;
			}
			const result = await client.query<ArticleSummaryRow>(`SELECT ${ARTICLE_SUMMARY_COLS} FROM articles WHERE ${where}`, params);
			return result.rows
				.sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0))
				.slice(0, limit)
				.map(formatSummary);
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
	} finally {
		await closeCorpusClient(client);
	}
}

export async function readCorpusItems(env: CoreEnv, items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
	const client = new PgClient({ connectionString: env.HYPERDRIVE.connectionString });
	try {
		await client.connect();
		return readItems(client, items, userId);
	} finally {
		await closeCorpusClient(client);
	}
}

async function closeCorpusClient(client: Client): Promise<void> {
	await client.end().catch((error) =>
		console.warn({
			tag: 'CORPUS',
			msg: 'client close failed',
			error: String(error),
		}),
	);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
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

async function rankArticles(
	client: Client,
	env: CoreEnv,
	query: string,
	limit = 100,
	options: RankArticleOptions = {},
): Promise<SearchRanks> {
	const sanitized = sanitize(query);
	if (!sanitized) return EMPTY_RANKS;

	const tokens = tokenize(sanitized);
	const patterns = tokens.length > 0 ? tokens.map((t) => `%${t}%`) : [`%${sanitized}%`];

	const embedding = await generateArticleEmbedding(sanitized, env.AI, env.AI_GATEWAY_NAME).catch(() => null);
	if (!embedding) return keywordOnly(client, patterns, limit, options);
	const vectorStr = `[${embedding.join(',')}]`;
	const params: unknown[] = [
		vectorStr,
		Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP),
		patterns,
		RRF_K,
		RECENCY_HALF_LIFE_DAYS,
		limit,
	];
	const dateFilter = options.fromDate ? ` AND published_date >= $${params.push(options.fromDate)}` : '';

	try {
		const result = await client.query<{ id: string; score: number | string }>(
			`
			WITH vec AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
				FROM articles
				WHERE embedding IS NOT NULL${dateFilter}
				ORDER BY embedding <=> $1::vector
				LIMIT $2
			),
			kw AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY published_date DESC NULLS LAST) AS rank
				FROM articles
				WHERE (
					EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ILIKE ANY($3::text[]))
					OR title ILIKE ANY($3::text[])
					OR title_cn ILIKE ANY($3::text[])
				)${dateFilter}
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
			params,
		);
		return new Map(result.rows.map((r) => [r.id, Number(r.score)]));
	} catch (error) {
		console.warn({ tag: 'CORPUS', msg: 'hybrid query failed, falling back to keyword search', error: String(error) });
		return keywordOnly(client, patterns, limit, options);
	}
}

async function keywordOnly(client: Client, patterns: string[], limit: number, options: RankArticleOptions = {}): Promise<SearchRanks> {
	const params: unknown[] = [patterns, limit];
	const dateFilter = options.fromDate ? ` AND published_date >= $${params.push(options.fromDate)}` : '';
	try {
		const result = await client.query<{ id: string; match_count: number | string }>(
			`
			SELECT id,
				(SELECT COUNT(*) FROM unnest(keywords) k WHERE k ILIKE ANY($1::text[])) AS match_count
			FROM articles
			WHERE (
				EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ILIKE ANY($1::text[]))
				OR title ILIKE ANY($1::text[])
				OR title_cn ILIKE ANY($1::text[])
			)${dateFilter}
			ORDER BY match_count DESC, published_date DESC NULLS LAST
			LIMIT $2
			`,
			params,
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

function extractVideoId(url: string | null): string | null {
	return url?.match(YT_RE)?.[1] ?? null;
}

function truncate(content: string | null | undefined, max: number): string {
	if (!content) return '';
	return content.length > max ? `${content.slice(0, max)}\n\n[Content truncated]` : content;
}

function capReadContextContent(results: ReadContextResult[]): ReadContextResult[] {
	const contentCount = results.filter((r) => r.content).length;
	if (contentCount === 0) return results;

	const perItemMax = Math.min(
		CONTENT_MAX,
		Math.max(READ_CONTEXT_MIN_ITEM_CONTENT_MAX, Math.floor(READ_CONTEXT_TOTAL_CONTENT_MAX / contentCount)),
	);
	return results.map((result) => {
		const content = result.content;
		if (!content || content.length <= perItemMax) return result;
		return { ...result, content: truncate(content, perItemMax) };
	});
}

function formatArticleReadResult(
	article: ArticleContentRow,
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
		meta.transcriptSegmentCount = transcript.segments.length;
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

function formatUserFileReadResult(file: UserFileContentRow): ReadContextResult {
	const title = file.title_cn || file.title || file.file_name;
	return {
		type: 'user_file',
		id: file.id,
		title,
		content: truncate(file.content_cn || file.extracted_text || file.summary_cn || file.summary, CONTENT_MAX),
		metadata: {
			url: file.source_url,
			source: file.site_name,
			publishedDate: file.published_date,
			tags: file.tags,
			fileName: file.file_name,
			fileType: file.file_type,
			resourceKind: file.resource_kind,
			sourceType: file.platform_type,
		},
	};
}

async function attachTranscripts(client: Client, articles: ArticleContentRow[]): Promise<ReadContextResult[]> {
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

async function readArticles(client: Client, ids: string[]): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();
	const result = await client.query<ArticleContentRow>(`SELECT ${ARTICLE_CONTENT_COLS} FROM articles WHERE id = ANY($1::uuid[])`, [
		validIds,
	]);
	const formatted = await attachTranscripts(client, result.rows);
	return new Map(formatted.map((r) => [r.id, r]));
}

async function readUserFiles(client: Client, ids: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();
	const result = await client.query<UserFileContentRow>(
		`SELECT id, file_name, file_type, resource_kind, title, title_cn, source_url, normalized_source_url,
		        site_name, platform_type, published_date, summary, summary_cn, extracted_text, content_cn, tags
		   FROM user_files
		  WHERE id = ANY($1::uuid[]) AND user_id = $2`,
		[validIds, userId],
	);
	const formatted = result.rows.map(formatUserFileReadResult);
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
	const articleMap = new Map(articlesResult.rows.map((a) => [a.id, a] as const));

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

async function readUrls(client: Client, urls: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const urlPairs = urls.map((u) => [u, normalizeUrl(u)] as const);
	const candidateUrls = [...new Set(urlPairs.flat())];

	const [articleResult, fileResult] = await Promise.all([
		client.query<ArticleContentRow>(`SELECT ${ARTICLE_CONTENT_COLS} FROM articles WHERE url = ANY($1::text[])`, [candidateUrls]),
		client.query<UserFileContentRow>(
			`SELECT id, file_name, file_type, resource_kind, title, title_cn, source_url, normalized_source_url,
			        site_name, platform_type, published_date, summary, summary_cn, extracted_text, content_cn, tags
			   FROM user_files
			  WHERE user_id = $2
			    AND (source_url = ANY($1::text[]) OR normalized_source_url = ANY($1::text[]))`,
			[candidateUrls, userId],
		),
	]);
	const articleMap = new Map(articleResult.rows.map((a) => [a.url, a] as const));
	const fileMap = new Map<string, UserFileContentRow>();
	for (const file of fileResult.rows) {
		if (file.source_url) fileMap.set(file.source_url, file);
		if (file.normalized_source_url) fileMap.set(file.normalized_source_url, file);
	}
	const articleMatches = urlPairs
		.map(([url, norm]) => ({ url, article: articleMap.get(url) ?? articleMap.get(norm) }))
		.filter((m): m is { url: string; article: ArticleContentRow } => !!m.article);
	const fileMatches = urlPairs
		.filter(([url, norm]) => !articleMap.has(url) && !articleMap.has(norm))
		.map(([url, norm]) => ({ url, file: fileMap.get(url) ?? fileMap.get(norm) }))
		.filter((m): m is { url: string; file: UserFileContentRow } => !!m.file);

	const formattedArticles = await attachTranscripts(
		client,
		articleMatches.map((m) => m.article),
	);
	const formattedArticleById = new Map(formattedArticles.map((r) => [r.id, r] as const));
	const formattedFiles = new Map(fileMatches.map((m) => [m.url, formatUserFileReadResult(m.file)] as const));
	return new Map([...articleMatches.map((m) => [m.url, formattedArticleById.get(m.article.id)!] as const), ...formattedFiles]);
}

async function readItems(client: Client, items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
	const groups = new Map<ResourceType, string[]>();
	for (const item of items) {
		const list = groups.get(item.type) ?? [];
		list.push(item.id);
		groups.set(item.type, list);
	}

	const resultMaps = new Map<ResourceType, Map<string, ReadContextResult>>();
	await Promise.all(
		[...groups.entries()].map(async ([type, ids]) => {
			const results =
				type === 'article'
					? await readArticles(client, ids)
					: type === 'collection'
						? await readCollections(client, ids, userId)
						: type === 'user_file'
							? await readUserFiles(client, ids, userId)
							: await readUrls(client, ids, userId);
			resultMaps.set(type, results);
		}),
	);

	return capReadContextContent(
		items.map(
			(item) =>
				resultMaps.get(item.type)?.get(item.id) ?? { type: 'error' as const, id: item.id, error: `${item.type} not found: ${item.id}` },
		),
	);
}
