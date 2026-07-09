import { generateArticleEmbedding } from '@core-ai/embedding';
import { normalizeUrl } from '@core-shared/web';
import { type CoreDb, withCoreDb } from '@db/client';
import { type SQL, sql } from 'drizzle-orm';

export interface ResourceSummary {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	source?: string | null;
	summary?: string;
	tags?: string[] | null;
}

export type ResourceSearchInput = {
	query: string;
	daysAgo?: number;
	limit?: number;
};

export type ResourceRankSearchInput = {
	query: string;
	limit?: number;
};

export type RelatedResourceSearchInput = {
	seed: { id: string; type: 'resource' };
	limit?: number;
	offset?: number;
};

export interface ReadContextItem {
	type: 'collection' | 'resource' | 'url';
	id: string;
}

export interface ReadContextResult {
	type: 'collection' | 'resource' | 'url' | 'document' | 'error';
	id: string;
	title?: string;
	content?: string;
	resources?: Array<{ id: string; title: string; summary: string | null }>;
	metadata?: Record<string, unknown>;
	error?: string;
}

type SearchRanks = Map<string, number>;
type ResourceType = ReadContextItem['type'];
type RankResourceOptions = { fromDate?: Date | null };

interface ResourceContentRow {
	id: string;
	type: string;
	url: string | null;
	normalized_url: string | null;
	scope: string;
	storage_key: string | null;
	file_type: string | null;
	original_lang: string;
	published_date: Date | string | null;
	scraped_date: Date | string | null;
	tags: string[] | null;
	title: string | null;
	summary: string | null;
	content: string | null;
	keywords: string[] | null;
	translation_lang: string | null;
}

interface ResourceSearchRow {
	id: string;
	title: string | null;
	url: string | null;
	published_date: Date | string | null;
	source: string | null;
	summary: string | null;
	tags: string[] | null;
}

type ResourceSummaryRow = Pick<ResourceContentRow, 'id' | 'title' | 'summary'>;
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function searchCorpusResourceRanks(
	env: CoreEnv,
	input: ResourceRankSearchInput,
): Promise<Array<{ id: string; score: number }>> {
	const query = input.query.trim();
	if (!query) return [];
	const limit = clampInt(input.limit, 1, SEARCH_RANK_LIMIT_MAX, 100);
	return withCoreDb(env, async (db) => {
		const ranks = await rankResources(db, env, query, limit);
		return [...ranks].map(([id, score]) => ({ id, score }));
	});
}

export async function relatedCorpusResourceIds(env: CoreEnv, input: RelatedResourceSearchInput): Promise<string[]> {
	const seed = { id: input.seed.id.trim(), type: input.seed.type };
	if (!seed.id) return [];
	const limit = clampInt(input.limit, 1, RELATED_LIMIT_MAX, RELATED_LIMIT_DEFAULT);
	const offset = clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
	return withCoreDb(env, async (db) => {
		const ids = await relatedResources(db, seed, limit, offset);
		return [...new Set(ids)].filter((id) => id !== seed.id);
	});
}

export async function searchCorpusResources(env: CoreEnv, input: ResourceSearchInput): Promise<ResourceSummary[]> {
	const query = input.query.trim();
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT);
	return withCoreDb(env, async (db) => {
		const fromDate = input.daysAgo ? new Date(Date.now() - input.daysAgo * 86_400_000) : null;
		const rankLimit = Math.min(SEARCH_LIMIT, Math.max(limit * SEARCH_RANK_BUFFER_MULTIPLIER, SEARCH_RANK_BUFFER_MIN));
		const ranks = query ? await rankResources(db, env, query, rankLimit, { fromDate }) : null;

		if (ranks) {
			if (ranks.size === 0) return [];
			const candidateIds = [...ranks.keys()].filter(isValidUuid);
			if (candidateIds.length === 0) return [];
			const rows = await queryRows<ResourceSearchRow>(
				db,
				sql`
					SELECT ${resourceSearchSelect()}
					FROM resources r
					${resourceLocalizedJoin()}
					WHERE r.id = ANY(${candidateIds}::uuid[])
						AND r.scope = 'corpus'
						AND r.enrichment_status = 'enriched'
						${fromDate ? sql`AND COALESCE(r.published_date, r.scraped_date, r.created_at) >= ${fromDate}` : sql``}
				`,
			);
			return rows
				.sort((a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0))
				.slice(0, limit)
				.map(formatSummary);
		}

		const rows = await queryRows<ResourceSearchRow>(
			db,
			sql`
				SELECT ${resourceSearchSelect()}
				FROM resources r
				${resourceLocalizedJoin()}
				WHERE r.scope = 'corpus'
					AND r.enrichment_status = 'enriched'
					${fromDate ? sql`AND COALESCE(r.published_date, r.scraped_date, r.created_at) >= ${fromDate}` : sql``}
				ORDER BY COALESCE(r.published_date, r.scraped_date, r.created_at) DESC
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

function formatSummary(resource: ResourceSearchRow): ResourceSummary {
	const summary = resource.summary ?? undefined;
	return {
		id: resource.id,
		title: resource.title || resource.url || 'Untitled resource',
		url: resource.url ?? '',
		publishedDate: toIsoString(resource.published_date),
		source: resource.source ?? undefined,
		summary: summary ? summary.slice(0, SUMMARY_MAX) : undefined,
		tags: resource.tags ?? undefined,
	};
}

async function relatedResources(db: CoreDb, seed: { id: string; type: 'resource' }, limit: number, offset: number): Promise<string[]> {
	if (!isValidUuid(seed.id)) return [];
	const rows = await queryRows<{ id: string }>(
		db,
		sql`
			WITH src AS (
				SELECT embedding FROM resources WHERE id = ${seed.id}::uuid AND embedding IS NOT NULL LIMIT 1
			)
			SELECT r.id
			FROM resources r, src
			WHERE r.id <> ${seed.id}::uuid
				AND r.scope = 'corpus'
				AND r.enrichment_status = 'enriched'
				AND r.embedding IS NOT NULL
			ORDER BY r.embedding <=> src.embedding
			LIMIT ${limit} OFFSET ${offset}
		`,
	);
	return rows.map((r) => r.id);
}

async function rankResources(
	db: CoreDb,
	env: CoreEnv,
	query: string,
	limit = 100,
	options: RankResourceOptions = {},
): Promise<SearchRanks> {
	const sanitized = sanitize(query);
	if (!sanitized) return EMPTY_RANKS;

	const tokens = tokenize(sanitized);
	const patterns = tokens.length > 0 ? tokens.map((t) => `%${t}%`) : [`%${sanitized}%`];

	const embedding = await generateArticleEmbedding(sanitized, env.AI, env.AI_GATEWAY_NAME).catch(() => null);
	if (!embedding) return keywordOnly(db, patterns, limit, options);
	const vectorStr = `[${embedding.join(',')}]`;
	const overfetchLimit = Math.min(limit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP);
	const dateFilter = () =>
		options.fromDate ? sql` AND COALESCE(r.published_date, r.scraped_date, r.created_at) >= ${options.fromDate}` : sql``;

	try {
		const rows = await queryRows<{ id: string; score: number | string }>(
			db,
			sql`
			WITH vec AS (
				SELECT r.id, ROW_NUMBER() OVER (ORDER BY r.embedding <=> ${vectorStr}::vector) AS rank
				FROM resources r
				WHERE r.scope = 'corpus'
					AND r.enrichment_status = 'enriched'
					AND r.embedding IS NOT NULL${dateFilter()}
				ORDER BY r.embedding <=> ${vectorStr}::vector
				LIMIT ${overfetchLimit}
			),
			kw AS (
				SELECT r.id, ROW_NUMBER() OVER (ORDER BY COALESCE(r.published_date, r.scraped_date, r.created_at) DESC NULLS LAST) AS rank
				FROM resources r
				WHERE r.scope = 'corpus'
					AND r.enrichment_status = 'enriched'
					AND (
					EXISTS (SELECT 1 FROM unnest(r.tags) k WHERE k ILIKE ANY(${patterns}::text[]))
					OR EXISTS (
						SELECT 1
						FROM resource_translations rt
						WHERE rt.resource_id = r.id
							AND (
								EXISTS (SELECT 1 FROM unnest(rt.keywords) k WHERE k ILIKE ANY(${patterns}::text[]))
								OR rt.title ILIKE ANY(${patterns}::text[])
								OR rt.summary ILIKE ANY(${patterns}::text[])
							)
					)
					OR r.type ILIKE ANY(${patterns}::text[])
					OR r.url ILIKE ANY(${patterns}::text[])
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
				s.s * (1.0 / (1 + EXTRACT(EPOCH FROM now() - COALESCE(r.published_date, r.scraped_date, r.created_at)) / 86400.0 / ${RECENCY_HALF_LIFE_DAYS})) AS score
			FROM scored s
			JOIN resources r ON s.id = r.id
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

async function keywordOnly(db: CoreDb, patterns: string[], limit: number, options: RankResourceOptions = {}): Promise<SearchRanks> {
	const dateFilter = () =>
		options.fromDate ? sql` AND COALESCE(r.published_date, r.scraped_date, r.created_at) >= ${options.fromDate}` : sql``;
	try {
		const rows = await queryRows<{ id: string; match_count: number | string }>(
			db,
			sql`
			SELECT r.id,
				(
					(SELECT COUNT(*) FROM unnest(r.tags) k WHERE k ILIKE ANY(${patterns}::text[]))
					+ CASE WHEN r.type ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
					+ CASE WHEN r.url ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
					+ (
						SELECT COALESCE(SUM(
							(SELECT COUNT(*) FROM unnest(rt.keywords) k WHERE k ILIKE ANY(${patterns}::text[]))
							+ CASE WHEN rt.title ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
							+ CASE WHEN rt.summary ILIKE ANY(${patterns}::text[]) THEN 1 ELSE 0 END
						), 0)
						FROM resource_translations rt
						WHERE rt.resource_id = r.id
					)
				) AS match_count
			FROM resources r
			WHERE r.scope = 'corpus'
				AND r.enrichment_status = 'enriched'
				AND (
				EXISTS (SELECT 1 FROM unnest(r.tags) k WHERE k ILIKE ANY(${patterns}::text[]))
				OR EXISTS (
					SELECT 1
					FROM resource_translations rt
					WHERE rt.resource_id = r.id
						AND (
							EXISTS (SELECT 1 FROM unnest(rt.keywords) k WHERE k ILIKE ANY(${patterns}::text[]))
							OR rt.title ILIKE ANY(${patterns}::text[])
							OR rt.summary ILIKE ANY(${patterns}::text[])
						)
				)
				OR r.type ILIKE ANY(${patterns}::text[])
				OR r.url ILIKE ANY(${patterns}::text[])
			)${dateFilter()}
			ORDER BY match_count DESC, COALESCE(r.published_date, r.scraped_date, r.created_at) DESC NULLS LAST
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

function resourceLocalizedJoin(): SQL {
	return sql`
		LEFT JOIN LATERAL (
			SELECT lang, title, summary, content, keywords, translation_source
			FROM resources_localized
			WHERE id = r.id
			ORDER BY
				(lang = r.original_lang) DESC,
				(lang = 'en') DESC,
				(lang = 'zh-Hant') DESC,
				(translation_source = 'original') DESC,
				lang ASC
			LIMIT 1
		) rt ON TRUE
	`;
}

function resourceReadSelect(userId: string): SQL {
	return sql`
		r.id::text,
		r.type,
		r.url,
		r.normalized_url,
		r.scope,
		r.storage_key,
		r.file_type,
		r.original_lang,
		r.published_date,
		r.scraped_date,
		r.tags,
		rt.title AS title,
		rt.summary AS summary,
		CASE WHEN EXISTS (
			SELECT 1
			FROM library content_library
			WHERE content_library.resource_id = r.id AND content_library.user_id = ${userId}
		)
		THEN rt.content
		ELSE NULL
		END AS content,
		rt.keywords AS keywords,
		rt.lang AS translation_lang
	`;
}

function resourceSummarySelect(): SQL {
	return sql`
		r.id::text,
		rt.title AS title,
		rt.summary AS summary
	`;
}

function resourceSearchSelect(): SQL {
	return sql`
		r.id::text,
		rt.title AS title,
		r.url,
		COALESCE(r.published_date, r.scraped_date, r.created_at) AS published_date,
		r.type AS source,
		rt.summary AS summary,
		r.tags
	`;
}

function resourceAccessPredicate(userId: string): SQL {
	return sql`
		(
			r.scope = 'corpus'
			OR EXISTS (
				SELECT 1
				FROM library l
				WHERE l.resource_id = r.id AND l.user_id = ${userId}
			)
		)
	`;
}

function formatResourceReadResult(resource: ResourceContentRow): ReadContextResult {
	const title = resource.title || resource.url || 'Untitled resource';
	const publishedDate = resource.published_date ?? resource.scraped_date;
	return {
		type: 'resource',
		id: resource.id,
		title,
		content: truncate(resource.content || resource.summary, CONTENT_MAX),
		metadata: {
			url: resource.url,
			source: resource.type,
			publishedDate,
			tags: resource.tags,
			keywords: resource.keywords,
			scope: resource.scope,
			originalLang: resource.original_lang,
			translationLang: resource.translation_lang,
			storageKey: resource.storage_key,
			fileType: resource.file_type,
		},
	};
}

async function readResources(db: CoreDb, ids: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();
	const rows = await queryRows<ResourceContentRow>(
		db,
		sql`
			SELECT ${resourceReadSelect(userId)}
			FROM resources r
			${resourceLocalizedJoin()}
			WHERE r.id = ANY(${validIds}::uuid[])
				AND ${resourceAccessPredicate(userId)}
		`,
	);
	const formatted = rows.map(formatResourceReadResult);
	return new Map(formatted.map((r) => [r.id, r]));
}

async function readResourceSummaries(db: CoreDb, ids: string[], userId: string): Promise<Map<string, ResourceSummaryRow>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();
	const rows = await queryRows<ResourceSummaryRow>(
		db,
		sql`
			SELECT ${resourceSummarySelect()}
			FROM resources r
			${resourceLocalizedJoin()}
			WHERE r.id = ANY(${validIds}::uuid[])
				AND ${resourceAccessPredicate(userId)}
		`,
	);
	return new Map(rows.map((resource) => [resource.id, resource]));
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
					AND to_type = 'resource'
				ORDER BY created_at DESC
			`,
		),
	]);

	const resourceIdsByCollection = new Map<string, string[]>();
	for (const row of citationRows) {
		const list = resourceIdsByCollection.get(row.from_id) ?? [];
		if (list.length < COLLECTION_LIMIT) list.push(row.to_id);
		resourceIdsByCollection.set(row.from_id, list);
	}

	const allResourceIds = [...new Set(citationRows.map((r) => r.to_id).filter(isValidUuid))];
	if (allResourceIds.length === 0) {
		return new Map(
			collectionRows.map((col) => [
				col.id,
				{
					type: 'collection' as const,
					id: col.id,
					title: col.name,
					content: col.description || undefined,
					resources: [],
					metadata: { resourceCount: 0 },
				},
			]),
		);
	}

	const resourceMap = await readResourceSummaries(db, allResourceIds, userId);

	return new Map(
		collectionRows.map((col) => {
			const colResources = (resourceIdsByCollection.get(col.id) ?? [])
				.map((rid) => resourceMap.get(rid))
				.filter((resource): resource is ResourceSummaryRow => !!resource);
			const entries = colResources.map((resource) => ({
				id: resource.id,
				title: resource.title || 'Untitled resource',
				summary: resource.summary ? truncate(resource.summary, SUMMARY_MAX) : null,
			}));
			return [
				col.id,
				{
					type: 'collection' as const,
					id: col.id,
					title: col.name,
					content: col.description || undefined,
					resources: entries,
					metadata: { resourceCount: entries.length },
				},
			];
		}),
	);
}

async function readUrls(db: CoreDb, urls: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const urlPairs = urls.map((u) => [u, normalizeUrl(u)] as const);
	const candidateUrls = [...new Set(urlPairs.flat())];

	const resourceRows = await queryRows<ResourceContentRow>(
		db,
		sql`
			SELECT ${resourceReadSelect(userId)}
			FROM resources r
			${resourceLocalizedJoin()}
			WHERE (r.url = ANY(${candidateUrls}::text[]) OR r.normalized_url = ANY(${candidateUrls}::text[]))
				AND ${resourceAccessPredicate(userId)}
		`,
	);
	const resourceMap = new Map<string, ResourceContentRow>();
	for (const resource of resourceRows) {
		if (resource.url) resourceMap.set(resource.url, resource);
		if (resource.normalized_url) resourceMap.set(resource.normalized_url, resource);
	}
	const resourceMatches = urlPairs
		.map(([url, norm]) => ({ url, resource: resourceMap.get(url) ?? resourceMap.get(norm) }))
		.filter((m): m is { url: string; resource: ResourceContentRow } => !!m.resource);
	return new Map(resourceMatches.map((m) => [m.url, formatResourceReadResult(m.resource)] as const));
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
				type === 'collection'
					? await readCollections(db, ids, userId)
					: type === 'resource'
						? await readResources(db, ids, userId)
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
