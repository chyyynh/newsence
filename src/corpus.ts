import { generateArticleEmbedding } from '@core-ai/embedding';
import type { TranscriptSegment } from '@core-shared/types';
import { normalizeUrl } from '@core-shared/web';
import { type CoreDb, withCoreDb } from '@db/client';
import { type SQL, sql } from 'drizzle-orm';

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
	return withCoreDb(env, async (db) => {
		const ranks = await rankArticles(db, env, query, limit);
		return [...ranks].map(([id, score]) => ({ id, score }));
	});
}

export async function relatedCorpusArticleIds(env: CoreEnv, input: RelatedArticleSearchInput): Promise<string[]> {
	const seed = { id: input.seed.id.trim(), type: input.seed.type };
	if (!seed.id) return [];
	const limit = clampInt(input.limit, 1, RELATED_LIMIT_MAX, RELATED_LIMIT_DEFAULT);
	const offset = clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
	return withCoreDb(env, async (db) => {
		const ids = await relatedArticles(db, seed, limit, offset);
		return [...new Set(ids)].filter((id) => id !== seed.id);
	});
}

export async function searchCorpusArticles(env: CoreEnv, input: ArticleSearchInput): Promise<ArticleSummary[]> {
	const query = input.query.trim();
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT);
	return withCoreDb(env, async (db) => {
		const fromDate = input.daysAgo ? new Date(Date.now() - input.daysAgo * 86_400_000) : null;
		const rankLimit = Math.min(SEARCH_LIMIT, Math.max(limit * SEARCH_RANK_BUFFER_MULTIPLIER, SEARCH_RANK_BUFFER_MIN));
		const ranks = query ? await rankArticles(db, env, query, rankLimit, { fromDate }) : null;

		if (ranks) {
			if (ranks.size === 0) return [];
			const candidateIds = [...ranks.keys()].filter(isValidUuid);
			if (candidateIds.length === 0) return [];
			const rows = await queryRows<ArticleSummaryRow>(
				db,
				sql`
					SELECT ${sql.raw(ARTICLE_SUMMARY_COLS)}
					FROM articles
					WHERE id = ANY(${candidateIds}::uuid[])
					${fromDate ? sql`AND published_date >= ${fromDate}` : sql``}
				`,
			);
			return rows
				.sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0))
				.slice(0, limit)
				.map(formatSummary);
		}

		const rows = await queryRows<ArticleSummaryRow>(
			db,
			sql`
				SELECT ${sql.raw(ARTICLE_SUMMARY_COLS)}
				FROM articles
				WHERE ${fromDate ? sql`published_date >= ${fromDate}` : sql`TRUE`}
				ORDER BY published_date DESC
				LIMIT ${limit}
			`,
		);
		return rows.map(formatSummary);
	});
}

export async function readCorpusItems(env: CoreEnv, items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
	return withCoreDb(env, (db) => readItems(db, items, userId));
}

async function queryRows<T>(db: CoreDb, statement: SQL): Promise<T[]> {
	const result = await db.execute(statement);
	return result.rows as T[];
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
	db: CoreDb,
	seed: { id: string; type: 'article' | 'user_file' },
	limit: number,
	offset: number,
): Promise<string[]> {
	if (!isValidUuid(seed.id)) return [];
	const seedTable = sql.raw(seed.type === 'user_file' ? 'user_files' : 'articles');
	const rows = await queryRows<{ id: string }>(
		db,
		sql`
			WITH src AS (
				SELECT embedding FROM ${seedTable} WHERE id = ${seed.id}::uuid AND embedding IS NOT NULL LIMIT 1
			)
			SELECT a.id
			FROM articles a, src
			WHERE a.id <> ${seed.id}::uuid AND a.embedding IS NOT NULL
			ORDER BY a.embedding <=> src.embedding
			LIMIT ${limit} OFFSET ${offset}
		`,
	);
	return rows.map((r) => r.id);
}

async function rankArticles(db: CoreDb, env: CoreEnv, query: string, limit = 100, options: RankArticleOptions = {}): Promise<SearchRanks> {
	const sanitized = sanitize(query);
	if (!sanitized) return EMPTY_RANKS;

	const tokens = tokenize(sanitized);
	const patterns = tokens.length > 0 ? tokens.map((t) => `%${t}%`) : [`%${sanitized}%`];

	const embedding = await generateArticleEmbedding(sanitized, env.AI, env.AI_GATEWAY_NAME).catch(() => null);
	if (!embedding) return keywordOnly(db, patterns, limit, options);
	const vectorStr = `[${embedding.join(',')}]`;
	const overfetchLimit = Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP);
	const dateFilter = () => (options.fromDate ? sql` AND published_date >= ${options.fromDate}` : sql``);

	try {
		const rows = await queryRows<{ id: string; score: number | string }>(
			db,
			sql`
			WITH vec AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vectorStr}::vector) AS rank
				FROM articles
				WHERE embedding IS NOT NULL${dateFilter()}
				ORDER BY embedding <=> ${vectorStr}::vector
				LIMIT ${overfetchLimit}
			),
			kw AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY published_date DESC NULLS LAST) AS rank
				FROM articles
				WHERE (
					EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ILIKE ANY(${patterns}::text[]))
					OR title ILIKE ANY(${patterns}::text[])
					OR title_cn ILIKE ANY(${patterns}::text[])
					OR summary ILIKE ANY(${patterns}::text[])
					OR summary_cn ILIKE ANY(${patterns}::text[])
					OR source ILIKE ANY(${patterns}::text[])
					OR url ILIKE ANY(${patterns}::text[])
				)${dateFilter()}
				LIMIT ${overfetchLimit}
			),
			fused AS (
				SELECT id, 1.0 / (${RRF_K} + rank) AS score FROM vec
				UNION ALL
				SELECT id, 1.0 / (${RRF_K} + rank) AS score FROM kw
			),
			scored AS (
				SELECT id, SUM(score) AS s FROM fused GROUP BY id
			)
			SELECT
				s.id::text,
				s.s * (1.0 / (1 + EXTRACT(EPOCH FROM now() - a.published_date) / 86400.0 / ${RECENCY_HALF_LIFE_DAYS})) AS score
			FROM scored s
			JOIN articles a ON s.id = a.id
			ORDER BY score DESC
			LIMIT ${limit}
			`,
		);
		return new Map(rows.map((r) => [r.id, Number(r.score)]));
	} catch (error) {
		console.warn({ tag: 'CORPUS', msg: 'hybrid query failed, falling back to keyword search', error: String(error) });
		return keywordOnly(db, patterns, limit, options);
	}
}

async function keywordOnly(db: CoreDb, patterns: string[], limit: number, options: RankArticleOptions = {}): Promise<SearchRanks> {
	const dateFilter = () => (options.fromDate ? sql` AND published_date >= ${options.fromDate}` : sql``);
	try {
		const rows = await queryRows<{ id: string; match_count: number | string }>(
			db,
			sql`
			SELECT id,
				(
					(SELECT COUNT(*) FROM unnest(keywords) k WHERE k ILIKE ANY(${patterns}::text[]))
					+ CASE WHEN title ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
					+ CASE WHEN title_cn ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
					+ CASE WHEN summary ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
					+ CASE WHEN summary_cn ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
					+ CASE WHEN source ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
					+ CASE WHEN url ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
				) AS match_count
			FROM articles
			WHERE (
				EXISTS (SELECT 1 FROM unnest(keywords) k WHERE k ILIKE ANY(${patterns}::text[]))
				OR title ILIKE ANY(${patterns}::text[])
				OR title_cn ILIKE ANY(${patterns}::text[])
				OR summary ILIKE ANY(${patterns}::text[])
				OR summary_cn ILIKE ANY(${patterns}::text[])
				OR source ILIKE ANY(${patterns}::text[])
				OR url ILIKE ANY(${patterns}::text[])
			)${dateFilter()}
			ORDER BY match_count DESC, published_date DESC NULLS LAST
			LIMIT ${limit}
			`,
		);
		const max = Math.max(...rows.map((r) => Number(r.match_count)), 1);
		return new Map(rows.map((r) => [r.id, Number(r.match_count) / max]));
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

function corpusErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

async function attachTranscripts(db: CoreDb, articles: ArticleContentRow[]): Promise<ReadContextResult[]> {
	const videoIds = articles
		.filter((a) => a.source_type === 'youtube')
		.map((a) => extractVideoId(a.url))
		.filter((v): v is string => !!v);

	let transcriptMap = new Map<string, { transcript: unknown; aiHighlights: unknown }>();
	if (videoIds.length > 0) {
		const rows = await queryRows<{ video_id: string; transcript: unknown; ai_highlights: unknown }>(
			db,
			sql`
				SELECT video_id, transcript, ai_highlights
				FROM youtube_transcripts
				WHERE video_id = ANY(${videoIds}::text[])
			`,
		);
		transcriptMap = new Map(rows.map((r) => [r.video_id, { transcript: r.transcript, aiHighlights: r.ai_highlights }]));
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

async function readArticles(db: CoreDb, ids: string[]): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();
	const rows = await queryRows<ArticleContentRow>(
		db,
		sql`
			SELECT ${sql.raw(ARTICLE_CONTENT_COLS)}
			FROM articles
			WHERE id = ANY(${validIds}::uuid[])
		`,
	);
	const formatted = await attachTranscripts(db, rows);
	return new Map(formatted.map((r) => [r.id, r]));
}

async function readUserFiles(db: CoreDb, ids: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();
	const rows = await queryRows<UserFileContentRow>(
		db,
		sql`
			SELECT id, file_name, file_type, resource_kind, title, title_cn, source_url, normalized_source_url,
				site_name, platform_type, published_date, summary, summary_cn, extracted_text, content_cn, tags
			FROM user_files
			WHERE id = ANY(${validIds}::uuid[]) AND user_id = ${userId}
		`,
	);
	const formatted = rows.map(formatUserFileReadResult);
	return new Map(formatted.map((r) => [r.id, r]));
}

async function readCollections(db: CoreDb, ids: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();

	const [collectionRows, citationRows] = await Promise.all([
		queryRows<{ id: string; name: string; description: string | null }>(
			db,
			sql`
				SELECT id, name, description
				FROM collections
				WHERE id = ANY(${validIds}::uuid[]) AND user_id = ${userId}
			`,
		),
		queryRows<{ from_id: string; to_id: string }>(
			db,
			sql`
				SELECT from_id, to_id
				FROM citations
				WHERE user_id = ${userId}
					AND from_type = 'collection'
					AND from_id = ANY(${validIds}::text[])
					AND to_type = 'article'
			`,
		),
	]);

	const articleIdsByCollection = new Map<string, string[]>();
	for (const row of citationRows) {
		const list = articleIdsByCollection.get(row.from_id) ?? [];
		if (list.length < COLLECTION_LIMIT) list.push(row.to_id);
		articleIdsByCollection.set(row.from_id, list);
	}

	const allArticleIds = [...new Set(citationRows.map((r) => r.to_id).filter(isValidUuid))];
	if (allArticleIds.length === 0) {
		return new Map(
			collectionRows.map((col) => [
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

	const articleRows = await queryRows<{
		id: string;
		title: string;
		title_cn: string | null;
		summary: string | null;
		summary_cn: string | null;
	}>(
		db,
		sql`
			SELECT id, title, title_cn, summary, summary_cn
			FROM articles
			WHERE id = ANY(${allArticleIds}::uuid[])
		`,
	);
	const articleMap = new Map(articleRows.map((a) => [a.id, a] as const));

	return new Map(
		collectionRows.map((col) => {
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

async function readUrls(db: CoreDb, urls: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const urlPairs = urls.map((u) => [u, normalizeUrl(u)] as const);
	const candidateUrls = [...new Set(urlPairs.flat())];

	const [articleRows, fileRows] = await Promise.all([
		queryRows<ArticleContentRow>(
			db,
			sql`
				SELECT ${sql.raw(ARTICLE_CONTENT_COLS)}
				FROM articles
				WHERE url = ANY(${candidateUrls}::text[])
			`,
		),
		queryRows<UserFileContentRow>(
			db,
			sql`
				SELECT id, file_name, file_type, resource_kind, title, title_cn, source_url, normalized_source_url,
					site_name, platform_type, published_date, summary, summary_cn, extracted_text, content_cn, tags
				FROM user_files
				WHERE user_id = ${userId}
					AND (source_url = ANY(${candidateUrls}::text[]) OR normalized_source_url = ANY(${candidateUrls}::text[]))
			`,
		),
	]);
	const articleMap = new Map(articleRows.map((a) => [a.url, a] as const));
	const fileMap = new Map<string, UserFileContentRow>();
	for (const file of fileRows) {
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
		db,
		articleMatches.map((m) => m.article),
	);
	const formattedArticleById = new Map(formattedArticles.map((r) => [r.id, r] as const));
	const formattedFiles = new Map(fileMatches.map((m) => [m.url, formatUserFileReadResult(m.file)] as const));
	return new Map([...articleMatches.map((m) => [m.url, formattedArticleById.get(m.article.id)!] as const), ...formattedFiles]);
}

async function readItems(db: CoreDb, items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
	const groups = new Map<ResourceType, string[]>();
	for (const item of items) {
		const list = groups.get(item.type) ?? [];
		list.push(item.id);
		groups.set(item.type, list);
	}

	const resultMaps = new Map<ResourceType, Map<string, ReadContextResult>>();
	const entries = [...groups.entries()];
	const settled = await Promise.allSettled(
		entries.map(async ([type, ids]) => {
			const results =
				type === 'article'
					? await readArticles(db, ids)
					: type === 'collection'
						? await readCollections(db, ids, userId)
						: type === 'user_file'
							? await readUserFiles(db, ids, userId)
							: await readUrls(db, ids, userId);
			return [type, results] as const;
		}),
	);
	for (const [index, settledResult] of settled.entries()) {
		const [type, ids] = entries[index];
		if (settledResult.status === 'fulfilled') {
			resultMaps.set(settledResult.value[0], settledResult.value[1]);
			continue;
		}

		const error = corpusErrorMessage(settledResult.reason);
		console.warn({ tag: 'CORPUS', msg: 'read group failed', type, count: ids.length, error });
		resultMaps.set(type, new Map(ids.map((id) => [id, { type: 'error' as const, id, error: `${type} read failed: ${error}` }])));
	}

	return capReadContextContent(
		items.map(
			(item) =>
				resultMaps.get(item.type)?.get(item.id) ?? { type: 'error' as const, id: item.id, error: `${item.type} not found: ${item.id}` },
		),
	);
}
