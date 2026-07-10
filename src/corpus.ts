import { normalizeUrl } from '@core-shared/web';
import { type CoreDb, withCoreDb } from '@db/client';
import { isValidUuid, queryRows, textArraySql, toIsoString, uuidArraySql } from '@db/sql';
import { type SQL, sql } from 'drizzle-orm';
import { searchCorpusRanks } from './ai-search';
import { resourceContentAccessSql, resourceTranslationOrderSql } from './resource-query-policy';

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

type ResourceType = ReadContextItem['type'];

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
const RESULT_LIMIT = 10;
const RESULT_LIMIT_MAX = 50;
const RELATED_LIMIT_DEFAULT = 12;
const RELATED_LIMIT_MAX = 500;
const SUMMARY_MAX = 500;
const CONTENT_MAX = 50000;
const READ_CONTEXT_TOTAL_CONTENT_MAX = 60000;
const READ_CONTEXT_MIN_ITEM_CONTENT_MAX = 4000;
const COLLECTION_LIMIT = 100;

export async function searchCorpusResourceRanks(
	env: CoreEnv,
	input: ResourceRankSearchInput,
): Promise<Array<{ id: string; score: number }>> {
	const query = input.query.trim();
	if (!query) return [];
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT_MAX);
	return (await searchCorpusRanks(env, query)).slice(0, limit);
}

export async function relatedCorpusResourceIds(env: CoreEnv, input: RelatedResourceSearchInput): Promise<string[]> {
	const seed = { id: input.seed.id.trim(), type: input.seed.type };
	if (!seed.id) return [];
	const limit = clampInt(input.limit, 1, RELATED_LIMIT_MAX, RELATED_LIMIT_DEFAULT);
	const offset = clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
	const seedText = await withCoreDb(env, (db) => relatedSeedText(db, seed.id));
	if (!seedText) return [];
	const ranks = await searchCorpusRanks(env, seedText);
	return ranks
		.map((rank) => rank.id)
		.filter((id) => id !== seed.id)
		.slice(offset, offset + limit);
}

export async function searchCorpusResources(env: CoreEnv, input: ResourceSearchInput): Promise<ResourceSummary[]> {
	const query = input.query.trim();
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT);
	const daysAgo = input.daysAgo === undefined ? null : clampInt(input.daysAgo, 0, 3650, 0);
	const fromDate = daysAgo ? new Date(Date.now() - daysAgo * 86_400_000) : null;
	const ranks = query ? new Map((await searchCorpusRanks(env, query, fromDate)).map(({ id, score }) => [id, score])) : null;
	return withCoreDb(env, async (db) => {
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
					WHERE r.id = ANY(${uuidArraySql(candidateIds)})
						AND ${corpusEnrichedSql()}${publishedSinceSql(fromDate)}
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
				WHERE ${corpusEnrichedSql()}${publishedSinceSql(fromDate)}
				ORDER BY ${recencySql()} DESC
				LIMIT ${limit}
			`,
		);
		return rows.map(formatSummary);
	});
}

export async function readCorpusItems(env: CoreEnv, items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
	return withCoreDb(env, (db) => readItems(db, items, userId));
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
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

async function relatedSeedText(db: CoreDb, resourceId: string): Promise<string | null> {
	if (!isValidUuid(resourceId)) return null;
	const rows = await queryRows<{ title: string | null; summary: string | null; tags: string[] | null }>(
		db,
		sql`
			SELECT rt.title, rt.summary, r.tags
			FROM resources r
			LEFT JOIN LATERAL (
				SELECT title, summary FROM resources_localized WHERE id = r.id LIMIT 1
			) rt ON TRUE
			WHERE r.id = ${resourceId}::uuid AND ${corpusEnrichedSql()}
			LIMIT 1
		`,
	);
	const row = rows[0];
	return row ? [row.title, row.summary, row.tags?.join(' ')].filter(Boolean).join('\n').slice(0, 4000) : null;
}

function recencySql(): SQL {
	return sql`COALESCE(r.published_date, r.scraped_date, r.created_at)`;
}

function corpusEnrichedSql(): SQL {
	return sql`r.scope = 'corpus' AND r.enrichment_status = 'enriched'`;
}

function publishedSinceSql(fromDate: Date | null | undefined): SQL {
	return fromDate ? sql` AND ${recencySql()} >= ${fromDate}` : sql``;
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
			ORDER BY ${resourceTranslationOrderSql({ lang: sql`lang`, originalLang: sql`r.original_lang` })}
			LIMIT 1
		) rt ON TRUE
	`;
}

function resourceReadSelect(userId: string): SQL {
	const canReadContent = resourceContentAccessSql('ai-tools', {
		hasViewer: sql`TRUE`,
		inViewerLibrary: sql`EXISTS (
			SELECT 1
			FROM library content_library
			WHERE content_library.resource_id = r.id AND content_library.user_id = ${userId}
		)`,
		scope: sql`r.scope`,
	});
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
		CASE WHEN ${canReadContent}
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
		${recencySql()} AS published_date,
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
				WHERE r.id = ANY(${uuidArraySql(validIds)})
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
				WHERE r.id = ANY(${uuidArraySql(validIds)})
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
					WHERE id = ANY(${uuidArraySql(validIds)}) AND user_id = ${userId}
			`,
		),
		queryRows<{ from_id: string; to_id: string }>(
			db,
			sql`
				SELECT from_id, to_id
				FROM citations
				WHERE user_id = ${userId}
					AND from_type = 'collection'
						AND from_id = ANY(${textArraySql(validIds)})
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
	const candidateUrlArray = textArraySql(candidateUrls);

	const resourceRows = await queryRows<ResourceContentRow>(
		db,
		sql`
			SELECT ${resourceReadSelect(userId)}
			FROM resources r
			${resourceLocalizedJoin()}
				WHERE (r.url = ANY(${candidateUrlArray}) OR r.normalized_url = ANY(${candidateUrlArray}))
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
