import {
	CONTENT_RESOURCE_TYPES,
	type ContentResourceType,
	isContentResourceType,
	RESOURCE_CATEGORIES,
	type ResourceCategory,
} from '@core-shared/resource-types';
import { normalizeUrl } from '@core-shared/url';
import { type CoreDb, isValidUuid, queryRows, resourceContentAccessSql, textArraySql, uuidArraySql, withCoreDb } from '@db/client';
import { type SQL, sql } from 'drizzle-orm';
import { searchCorpusRanks } from './ai-search';

interface ResourceSummary {
	id: string;
	title: string;
	url: string;
	publishedDate?: string;
	source: string;
	summary?: string;
	tags?: string[];
}

export type ResourceSearchInput = {
	query: string;
	limit?: number;
	filters?: ResourceSearchFilters;
};

type ResourceSearchFilters = {
	categories?: ResourceCategory[];
	effectiveAfter?: string;
	effectiveBefore?: string;
	sourceIds?: string[];
	types?: ContentResourceType[];
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

interface ReadContextResult {
	type: 'collection' | 'resource' | 'url' | 'document' | 'error';
	id: string;
	title?: string;
	content?: string;
	resources?: Array<{ id: string; title: string; summary: string | null }>;
	metadata?: Record<string, unknown>;
	error?: string;
}

type ReadContextType = ReadContextItem['type'];

interface ResourceContentRow {
	id: string;
	url: string | null;
	normalized_url: string | null;
	scope: string;
	storage_key: string | null;
	file_type: string | null;
	original_lang: string;
	published_date: Date | string | null;
	source: string | null;
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
const RELATED_LIMIT_MAX = RESULT_LIMIT_MAX;
const SUMMARY_MAX = 500;
const CONTENT_MAX = 50000;
const READ_CONTEXT_TOTAL_CONTENT_MAX = 60000;
const COLLECTION_LIMIT = 100;

type NormalizedSearchFilters = {
	categories?: ResourceCategory[];
	effectiveAfter: Date | null;
	effectiveBefore: Date | null;
	excludeAll: boolean;
	sourceIds?: string[];
	types?: ContentResourceType[];
};

export async function searchCorpusResourceRanks(env: CoreEnv, input: ResourceSearchInput): Promise<Array<{ id: string; score: number }>> {
	const query = input.query.trim();
	if (!query) return [];
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT_MAX);
	const filters = normalizeSearchFilters(input);
	if (filters.excludeAll) return [];
	return (await searchCorpusRanks(env, query, filters)).slice(0, limit);
}

export async function relatedCorpusResourceIds(env: CoreEnv, input: RelatedResourceSearchInput): Promise<string[]> {
	const seed = { id: input.seed.id.trim(), type: input.seed.type };
	if (!seed.id) return [];
	const limit = clampInt(input.limit, 1, RELATED_LIMIT_MAX, RELATED_LIMIT_DEFAULT);
	const offset = clampInt(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
	const seedText = await withCoreDb(env, (db) => relatedSeedText(db, seed.id));
	if (!seedText) return [];
	const ranks = await searchCorpusRanks(env, seedText, { profile: 'related' });
	return ranks
		.map((rank) => rank.id)
		.filter((id) => id !== seed.id)
		.slice(offset, offset + limit);
}

export async function searchCorpusResources(env: CoreEnv, input: ResourceSearchInput): Promise<ResourceSummary[]> {
	const query = input.query.trim();
	const limit = clampInt(input.limit, 1, RESULT_LIMIT_MAX, RESULT_LIMIT);
	const filters = normalizeSearchFilters(input);
	if (filters.excludeAll) return [];
	const rankedIds = query ? (await searchCorpusRanks(env, query, filters)).map((rank) => rank.id) : null;
	return withCoreDb(env, async (db) => {
		if (rankedIds) {
			const candidateIds = rankedIds.filter(isValidUuid);
			if (candidateIds.length === 0) return [];
			const rows = await queryRows<ResourceSearchRow>(
				db,
				sql`
					SELECT ${resourceSearchSelect()}
					FROM resources r
					${resourceReadJoins()}
					WHERE r.id = ANY(${uuidArraySql(candidateIds)})
						AND ${corpusEnrichedSql()}${searchFiltersSql(filters)}
					ORDER BY array_position(${uuidArraySql(candidateIds)}, r.id)
					LIMIT ${limit}
				`,
			);
			return rows.map(formatSummary);
		}

		const rows = await queryRows<ResourceSearchRow>(
			db,
			sql`
				SELECT ${resourceSearchSelect()}
				FROM resources r
				${resourceReadJoins()}
				WHERE ${corpusEnrichedSql()}${searchFiltersSql(filters)}
				ORDER BY ${recencySql()} DESC, r.id DESC
				LIMIT ${limit}
			`,
		);
		return rows.map(formatSummary);
	});
}

export async function readCorpusItems(env: CoreEnv, items: ReadContextItem[], userId: string): Promise<ReadContextResult[]> {
	return withCoreDb(env, (db) => readItems(db, items, userId));
}

function clampInt(value: number | undefined, min: number, max: number, defaultValue: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function optionalSearchDate(value: string | undefined, field: string): Date | null {
	if (value === undefined) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}`);
	return date;
}

function normalizeSearchFilters(input: ResourceSearchInput): NormalizedSearchFilters {
	const filters = input.filters ?? {};
	const effectiveAfter = optionalSearchDate(filters.effectiveAfter, 'effectiveAfter');
	const effectiveBefore = optionalSearchDate(filters.effectiveBefore, 'effectiveBefore');
	if (effectiveAfter && effectiveBefore && effectiveAfter > effectiveBefore)
		throw new Error('effectiveAfter must not exceed effectiveBefore');
	const sourceIds = optionalSourceIds(filters.sourceIds);
	const types = optionalResourceTypes(filters.types);
	const categories = optionalResourceCategories(filters.categories);
	return {
		categories,
		effectiveAfter,
		effectiveBefore,
		excludeAll: sourceIds?.length === 0 || types?.length === 0 || categories?.length === 0,
		sourceIds,
		types,
	};
}

function optionalSourceIds(values: string[] | undefined): string[] | undefined {
	if (values === undefined) return undefined;
	const unique = [...new Set(values.map((value) => value.trim()))];
	if (unique.some((value) => !isValidUuid(value))) throw new Error('Invalid sourceIds');
	return unique;
}

function optionalResourceTypes(values: ContentResourceType[] | undefined): ContentResourceType[] | undefined {
	if (values === undefined) return undefined;
	if (values.some((value) => !isContentResourceType(value))) throw new Error('Invalid resource types');
	return [...new Set(values)];
}

function optionalResourceCategories(values: ResourceCategory[] | undefined): ResourceCategory[] | undefined {
	if (values === undefined) return undefined;
	if (values.some((value) => !(RESOURCE_CATEGORIES as readonly string[]).includes(value))) throw new Error('Invalid resource categories');
	return [...new Set(values)];
}

function formatSummary(resource: ResourceSearchRow): ResourceSummary {
	const summary = resource.summary ?? undefined;
	const publishedDate = optionalIsoDate(resource.published_date, resource.id);
	return {
		id: resource.id,
		title: requiredCorpusText(resource.title, 'title', resource.id),
		url: requiredCorpusText(resource.url, 'url', resource.id),
		...(publishedDate ? { publishedDate } : {}),
		source: requiredCorpusText(resource.source, 'source', resource.id),
		summary: summary ? summary.slice(0, SUMMARY_MAX) : undefined,
		tags: resource.tags ?? undefined,
	};
}

function requiredCorpusText(value: string | null, field: string, resourceId: string): string {
	const text = value?.trim();
	if (!text) throw new Error(`Corpus resource ${resourceId} is missing ${field}`);
	return text;
}

function optionalIsoDate(value: Date | string | null, resourceId: string): string | undefined {
	if (value === null) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Corpus resource ${resourceId} has invalid date`);
	return date.toISOString();
}

async function relatedSeedText(db: CoreDb, resourceId: string): Promise<string | null> {
	if (!isValidUuid(resourceId)) return null;
	const rows = await queryRows<{ title: string | null; summary: string | null; tags: string[] | null }>(
		db,
		sql`
			SELECT rt.title, rt.summary, r.tags
			FROM resources r
			LEFT JOIN LATERAL (
				SELECT title, summary
				FROM resources_localized
				WHERE id = r.id AND lang = r.original_lang
				LIMIT 1
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
	return sql`r.scope = 'corpus'
		AND r.enrichment_status = 'enriched'
		AND r.type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})`;
}

function searchFiltersSql(filters: NormalizedSearchFilters): SQL {
	return sql`${filters.effectiveAfter ? sql` AND ${recencySql()} >= ${filters.effectiveAfter}` : sql``}
		${filters.effectiveBefore ? sql` AND ${recencySql()} <= ${filters.effectiveBefore}` : sql``}
		${filters.sourceIds ? sql` AND r.source_id = ANY(${uuidArraySql(filters.sourceIds)})` : sql``}
		${filters.types ? sql` AND r.type = ANY(${textArraySql(filters.types)})` : sql``}
		${filters.categories ? sql` AND r.category = ANY(${textArraySql(filters.categories)})` : sql``}`;
}

function truncate(content: string | null | undefined, max: number): string {
	if (!content) return '';
	if (content.length <= max) return content;
	const marker = '\n\n[Content truncated]';
	return max > marker.length ? `${content.slice(0, max - marker.length)}${marker}` : content.slice(0, max);
}

function capReadContextContent(results: ReadContextResult[]): ReadContextResult[] {
	const readableCount = results.filter((result) => result.content || result.resources?.length).length;
	if (readableCount === 0) return results;

	const perItemMax = Math.min(CONTENT_MAX, Math.floor(READ_CONTEXT_TOTAL_CONTENT_MAX / readableCount));
	return results.map((result) => {
		const content = truncate(result.content, perItemMax) || undefined;
		let used = content?.length ?? 0;
		const resources = result.resources?.filter((resource) => {
			const size = resource.title.length + (resource.summary?.length ?? 0);
			if (used + size > perItemMax) return false;
			used += size;
			return true;
		});
		if (content === result.content && resources?.length === result.resources?.length) return result;
		return {
			...result,
			content,
			...(resources ? { resources, metadata: { ...result.metadata, resourceCount: resources.length } } : {}),
		};
	});
}

function resourceReadJoins(): SQL {
	return sql`
		LEFT JOIN sources monitored_source ON monitored_source.id = r.source_id
		LEFT JOIN LATERAL (
			SELECT lang, title, summary, content, keywords, translation_source
			FROM resources_localized
			WHERE id = r.id AND lang = r.original_lang
			LIMIT 1
		) rt ON TRUE
	`;
}

function viewerResourceOwnershipSql(userId: string): SQL {
	return sql`
		EXISTS (
			SELECT 1
			FROM resource_saves content_save
			WHERE content_save.resource_id = r.id AND content_save.user_id = ${userId}
		)
		OR EXISTS (
			SELECT 1
			FROM user_files content_file
			WHERE content_file.resource_id = r.id AND content_file.user_id = ${userId}
		)
	`;
}

function resourceReadSelect(userId: string): SQL {
	const canReadContent = resourceContentAccessSql('ai-tools', {
		viewerHasOwnership: viewerResourceOwnershipSql(userId),
		scope: sql`r.scope`,
	});
	return sql`
		r.id::text,
		r.url,
		r.normalized_url,
		r.scope,
		r.storage_key,
		r.file_type,
		r.original_lang,
		${recencySql()} AS published_date,
		COALESCE(NULLIF(monitored_source.name, ''), NULLIF(r.platform_metadata->>'sourceName', ''), r.type) AS source,
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
		COALESCE(NULLIF(monitored_source.name, ''), NULLIF(r.platform_metadata->>'sourceName', ''), r.type) AS source,
		rt.summary AS summary,
		r.tags
	`;
}

function resourceAccessPredicate(userId: string): SQL {
	return sql`
		r.type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
		AND (
			(r.scope = 'corpus' AND r.enrichment_status = 'enriched')
			OR (${viewerResourceOwnershipSql(userId)})
		)
	`;
}

function formatResourceReadResult(resource: ResourceContentRow): ReadContextResult {
	const publishedDate = optionalIsoDate(resource.published_date, resource.id);
	return {
		type: 'resource',
		id: resource.id,
		title: requiredCorpusText(resource.title, 'title', resource.id),
		content: resource.content ? truncate(resource.content, CONTENT_MAX) : undefined,
		metadata: {
			url: resource.url,
			source: requiredCorpusText(resource.source, 'source', resource.id),
			...(publishedDate ? { publishedDate } : {}),
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
			${resourceReadJoins()}
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
			${resourceReadJoins()}
				WHERE r.id = ANY(${uuidArraySql(validIds)})
				AND ${resourceAccessPredicate(userId)}
		`,
	);
	return new Map(rows.map((resource) => [resource.id, resource]));
}

async function readCollections(db: CoreDb, ids: string[], userId: string): Promise<Map<string, ReadContextResult>> {
	const validIds = ids.filter(isValidUuid);
	if (validIds.length === 0) return new Map();

	const [collectionRows, linkRows] = await Promise.all([
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
				FROM (
					SELECT edge.collection_id::text AS from_id,
					       edge.resource_id::text AS to_id,
					       edge.added_at,
					       ROW_NUMBER() OVER (
					         PARTITION BY edge.collection_id
					         ORDER BY edge.added_at DESC, edge.resource_id DESC
					       ) AS row_number
					FROM collection_resources edge
					JOIN collections collection
					  ON collection.id = edge.collection_id
					 AND collection.user_id = ${userId}
					WHERE edge.collection_id = ANY(${uuidArraySql(validIds)})
				) ranked_links
				WHERE row_number <= ${COLLECTION_LIMIT}
				ORDER BY added_at DESC, to_id DESC
			`,
		),
	]);

	const resourceIdsByCollection = new Map<string, string[]>();
	for (const row of linkRows) {
		const list = resourceIdsByCollection.get(row.from_id) ?? [];
		list.push(row.to_id);
		resourceIdsByCollection.set(row.from_id, list);
	}

	const allResourceIds = [...new Set([...resourceIdsByCollection.values()].flat().filter(isValidUuid))];
	const resourceMap = await readResourceSummaries(db, allResourceIds, userId);

	return new Map(
		collectionRows.map((col) => {
			const colResources = (resourceIdsByCollection.get(col.id) ?? [])
				.map((rid) => resourceMap.get(rid))
				.filter((resource): resource is ResourceSummaryRow => !!resource);
			const entries = colResources.map((resource) => ({
				id: resource.id,
				title: requiredCorpusText(resource.title, 'title', resource.id),
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
	const urlPairs = urls.flatMap((url) => {
		try {
			return [[url, normalizeUrl(url)] as const];
		} catch {
			return [];
		}
	});
	if (urlPairs.length === 0) return new Map();
	const candidateUrls = [...new Set(urlPairs.flat())];
	const candidateUrlArray = textArraySql(candidateUrls);

	const resourceRows = await queryRows<ResourceContentRow>(
		db,
		sql`
			SELECT ${resourceReadSelect(userId)}
			FROM resources r
			${resourceReadJoins()}
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
	const groups = new Map<ReadContextType, string[]>();
	for (const item of items) {
		const list = groups.get(item.type) ?? [];
		list.push(item.id);
		groups.set(item.type, list);
	}

	const entries = [...groups.entries()];
	const loaded = await Promise.all(
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
	const resultMaps = new Map<ReadContextType, Map<string, ReadContextResult>>(loaded);

	return capReadContextContent(
		items.map(
			(item) =>
				resultMaps.get(item.type)?.get(item.id) ?? { type: 'error' as const, id: item.id, error: `${item.type} not found: ${item.id}` },
		),
	);
}
