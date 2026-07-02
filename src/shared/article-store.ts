import { type DbClient, withDbClient } from './db';
import { type Article, ENTITY_TYPES, type EntityType, type Env } from './types';
import { normalizeUrl } from './web';

export const ARTICLES_TABLE = 'articles';
export const USER_FILES_TABLE = 'user_files';
export type ProcessableTable = typeof ARTICLES_TABLE | typeof USER_FILES_TABLE;

export function resolveProcessableTable(table?: string | null): ProcessableTable {
	if (!table) return ARTICLES_TABLE;
	if (table === ARTICLES_TABLE || table === USER_FILES_TABLE) return table;
	throw new Error(`Unsupported workflow target table: ${table}`);
}

export type ProcessableArticleShell = Article & { has_content?: boolean };

const ARTICLE_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

const ARTICLE_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, extracted_text AS content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

const ARTICLE_SHELL_FIELDS_FOR_ARTICLES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, content IS NOT NULL AND length(content) > 0 AS has_content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata, entities';

const ARTICLE_SHELL_FIELDS_FOR_USER_FILES =
	'id, title, title_cn, summary, summary_cn, NULL::text AS content, extracted_text IS NOT NULL AND length(extracted_text) > 0 AS has_content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, created_at AS scraped_date, og_image_url, metadata AS platform_metadata, entities, storage_key, file_type, origin_type';

function articleFieldsFor(table: ProcessableTable): string {
	return table === USER_FILES_TABLE ? ARTICLE_FIELDS_FOR_USER_FILES : ARTICLE_FIELDS_FOR_ARTICLES;
}

function articleShellFieldsFor(table: ProcessableTable): string {
	return table === USER_FILES_TABLE ? ARTICLE_SHELL_FIELDS_FOR_USER_FILES : ARTICLE_SHELL_FIELDS_FOR_ARTICLES;
}

async function fetchProcessableArticle<T extends Article>(
	env: Env,
	table: ProcessableTable,
	articleId: string,
	fields: string,
): Promise<T> {
	return withDbClient(env, async (db) => {
		const result = await db.query(`SELECT ${fields} FROM ${table} WHERE id = $1`, [articleId]);
		if (result.rows.length === 0) throw new Error(`Failed to fetch article ${articleId}: not found`);
		return result.rows[0] as T;
	});
}

export function loadProcessableArticle(env: Env, table: ProcessableTable, articleId: string): Promise<Article> {
	return fetchProcessableArticle(env, table, articleId, articleFieldsFor(table));
}

export function loadProcessableArticleShell(env: Env, table: ProcessableTable, articleId: string): Promise<ProcessableArticleShell> {
	return fetchProcessableArticle(env, table, articleId, articleShellFieldsFor(table));
}

export interface InsertArticleData {
	url: string;
	title: string;
	source: string;
	publishedDate: Date | string;
	summary: string;
	sourceType: string;
	content: string | null;
	ogImageUrl: string | null;
	platformMetadata: unknown | null;
	keywords?: string[];
	tags?: string[];
}

export type ProcessedArticleUpdate = Record<string, unknown>;

export type ArticleEntityInput = { name: string; name_cn: string; type: string };
export type MaintenanceCursor = { id: string; publishedDate: string };
type NormalizedArticleEntity = { name: string; name_cn: string; type: EntityType };
type ArticleEntityRepairRow = {
	id: string;
	source: string | null;
	platform_metadata: unknown;
	entities: unknown;
	published_date: string | Date | null;
};
type EntityQualityOverviewRow = {
	total_articles: number | string | null;
	with_entity_json: number | string | null;
	empty_entity_json: number | string | null;
	missing_entity_json: number | string | null;
	invalid_entity_json: number | string | null;
	json_without_links: number | string | null;
	max_entities_per_article: number | string | null;
	over_cap_articles: number | string | null;
	total_entities: number | string | null;
	total_entity_links: number | string | null;
	orphan_entities: number | string | null;
	article_count_drift: number | string | null;
	self_source_exact_links: number | string | null;
	generic_entity_links: number | string | null;
};
type EntityQualityCoverageCountsRow = {
	total_articles: number | string | null;
	with_entity_json: number | string | null;
	empty_entity_json: number | string | null;
	missing_or_invalid_entity_json: number | string | null;
	json_without_links: number | string | null;
};
type EntityQualityMonthlyRow = EntityQualityCoverageCountsRow & { month: string };
type EntityQualitySourceTypeRow = EntityQualityCoverageCountsRow & { source_type: string };
type EntityQualityMonthlySourceTypeRow = EntityQualityCoverageCountsRow & { month: string; source_type: string };
type EntityQualityTypeRow = { type: string; count: number | string | null };
type EntityQualityExtensionRow = { extname: string };
type EntityQualitySelfSourceOffenderRow = {
	canonical_name: string;
	name: string;
	source: string;
	links: number | string | null;
};
type EntityQualityGenericOffenderRow = {
	canonical_name: string;
	name: string;
	links: number | string | null;
};
type EntityQualityTypeExampleRow = {
	type: string;
	canonical_name: string;
	name: string;
	article_count: number | string | null;
};
type EntityQualitySyncGapRow = {
	id: string;
	title: string | null;
	source: string | null;
	source_type: string;
	published_date: string | Date | null;
	entity_count: number | string | null;
};
type EntityQualityBackfillRow = {
	first_entity_published_date: string | Date | null;
	processable_missing_or_empty: number | string | null;
	processable_missing_before_first_entity: number | string | null;
	oldest_processable_missing_published_date: string | Date | null;
	newest_processable_missing_published_date: string | Date | null;
};
type EntityQualityBackfillSourceTypeRow = {
	source_type: string;
	processable_missing_or_empty: number | string | null;
	processable_missing_before_first_entity: number | string | null;
	oldest_processable_missing_published_date: string | Date | null;
	newest_processable_missing_published_date: string | Date | null;
};

const GENERIC_ENTITY_CANONICALS = new Set(['ai', 'x', 'go', 'us', 'c', 'v4', 'rl', 'pi']);
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const ASCII_TICKER_ENTITY_RE = /^\$[a-z]{1,5}$/i;
const SOURCE_FEED_SUFFIX_CANONICALS = new Set([
	'ai',
	'article',
	'articles',
	'blog',
	'business',
	'crypto',
	'finance',
	'news',
	'research',
	'rss',
	'startup',
	'startups',
	'tech',
	'technology',
]);
const ENTITY_NAME_MAX_LENGTH = 255;
const ENTITY_TYPE_MAX_LENGTH = 20;
const MAX_ENTITIES_PER_ARTICLE = 10;
const ENTITY_QUALITY_TOP_LIMIT = 10;
const ENTITY_QUALITY_EXAMPLES_PER_TYPE = 3;

const ARTICLES_TO_USER_FILES_COLUMN_MAP: Record<string, string> = {
	content: 'extracted_text',
	url: 'source_url',
	source: 'site_name',
	platform_metadata: 'metadata',
	scraped_date: 'created_at',
};

function mapProcessedArticleColumn(column: string, table: ProcessableTable): string {
	if (table !== USER_FILES_TABLE) return column;
	return ARTICLES_TO_USER_FILES_COLUMN_MAP[column] ?? column;
}

function serializeProcessedArticleValue(column: string, value: unknown): unknown {
	if (value !== null && typeof value === 'object' && column !== 'tags' && column !== 'keywords') {
		return JSON.stringify(value);
	}
	return value;
}

function canonicalizeEntityName(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKC')
		.replace(/\s+/g, ' ')
		.replace(/^[\s"'`“”‘’([{]+|[\s"'`“”‘’.,:;!?)]}]+$/g, '')
		.trim();
}

function shouldStoreArticleEntity(entity: NormalizedArticleEntity, excludedCanonicalNames: ReadonlySet<string>): boolean {
	const canonical = canonicalizeEntityName(entity.name);
	if (!canonical || /^[a-z0-9]{1,2}$/i.test(canonical)) return false;
	if (canonical.length > ENTITY_NAME_MAX_LENGTH || entity.name.length > ENTITY_NAME_MAX_LENGTH) return false;
	if (entity.name_cn.length > ENTITY_NAME_MAX_LENGTH || entity.type.length > ENTITY_TYPE_MAX_LENGTH) return false;
	if (ASCII_TICKER_ENTITY_RE.test(canonical)) return false;
	if (GENERIC_ENTITY_CANONICALS.has(canonical)) return false;
	return !excludedCanonicalNames.has(canonical);
}

function normalizeEntityType(value: string): EntityType | null {
	const type = value.trim().toLowerCase();
	return ENTITY_TYPE_SET.has(type) ? (type as EntityType) : null;
}

function normalizeArticleEntity(entity: ArticleEntityInput): NormalizedArticleEntity | null {
	const name = entity.name.trim();
	const nameCn = entity.name_cn.trim();
	const type = normalizeEntityType(entity.type);
	if (!type) return null;
	return {
		name,
		name_cn: nameCn || name,
		type,
	};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function intValue(value: number | string | null | undefined): number {
	return Number(value ?? 0);
}

function isoDateValue(value: string | Date | null | undefined): string | null {
	return value ? new Date(value).toISOString() : null;
}

function sourceNameAliases(source?: string | null): string[] {
	const value = stringValue(source);
	if (!value) return [];
	const aliases = [value, ...sourceFeedBaseAliases(value)];

	const host = hostFromSource(value);
	if (host) {
		aliases.push(host);
		const labels = host.replace(/^www\./, '').split('.');
		if (labels.length > 1 && labels[0]) aliases.push(labels[0]);
	}
	return aliases;
}

function sourceFeedBaseAliases(value: string): string[] {
	const match = value.match(/^(.+?)\s+[-–—|:]\s+(.+)$/);
	if (!match) return [];
	const [, base, suffix] = match;
	const suffixTokens = canonicalizeEntityName(suffix)
		.split(/[\s/]+/)
		.filter(Boolean);
	if (!suffixTokens.length || !suffixTokens.every((token) => SOURCE_FEED_SUFFIX_CANONICALS.has(token))) return [];
	const alias = base.trim();
	return alias ? [alias] : [];
}

function hostFromSource(value: string): string | null {
	try {
		return new URL(value.includes('://') ? value : `https://${value}`).hostname.replace(/^www\./, '');
	} catch {
		return null;
	}
}

function platformMetadataSourceAliases(metadata: unknown): string[] {
	const envelope = recordValue(metadata);
	const data = recordValue(envelope?.data);
	const type = stringValue(envelope?.type);
	if (!type || !data) return [];
	const aliases: string[] = [];
	const add = (value: unknown) => {
		const str = stringValue(value);
		if (str) aliases.push(str);
	};

	if (type === 'twitter') {
		add(data.authorName);
		const userName = stringValue(data.authorUserName);
		if (userName) aliases.push(userName, `@${userName}`);
		aliases.push('Twitter', 'X');
	} else if (type === 'youtube') {
		add(data.channelName);
		aliases.push('YouTube');
	} else if (type === 'hackernews') {
		add(data.author);
		aliases.push('Hacker News');
	}
	return aliases;
}

function excludedEntityCanonicalNames(source?: string | null, platformMetadata?: unknown): Set<string> {
	const names = entityExtractionExclusionNames(source, platformMetadata);
	return new Set(names.map(canonicalizeEntityName).filter(Boolean));
}

export function entityExtractionExclusionNames(source?: string | null, platformMetadata?: unknown): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const name of [...sourceNameAliases(source), ...platformMetadataSourceAliases(platformMetadata)]) {
		const canonical = canonicalizeEntityName(name);
		if (!canonical || seen.has(canonical)) continue;
		seen.add(canonical);
		names.push(name.trim());
		if (names.length >= ENTITY_QUALITY_TOP_LIMIT) break;
	}
	return names;
}

export function normalizeArticleEntitiesForStorage(
	entities: ArticleEntityInput[],
	source?: string | null,
	platformMetadata?: unknown,
): NormalizedArticleEntity[] {
	const byCanonical = new Map<string, NormalizedArticleEntity>();
	const excludedCanonicals = excludedEntityCanonicalNames(source, platformMetadata);
	for (const entity of entities) {
		const normalized = normalizeArticleEntity(entity);
		if (!normalized) continue;
		const canonical = canonicalizeEntityName(normalized.name);
		if (!canonical || byCanonical.has(canonical) || !shouldStoreArticleEntity(normalized, excludedCanonicals)) continue;
		byCanonical.set(canonical, normalized);
		if (byCanonical.size >= MAX_ENTITIES_PER_ARTICLE) break;
	}
	return [...byCanonical.values()];
}

export function isArticleEntityInput(value: unknown): value is ArticleEntityInput {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return typeof record.name === 'string' && typeof record.name_cn === 'string' && typeof record.type === 'string';
}

export async function updateProcessedArticle(
	db: DbClient,
	table: ProcessableTable,
	articleId: string,
	updatePayload: ProcessedArticleUpdate,
): Promise<void> {
	const columns = Object.keys(updatePayload);
	if (columns.length === 0) return;

	const setClauses = columns.map((col, i) => `${mapProcessedArticleColumn(col, table)} = $${i + 1}`).join(', ');
	const values = columns.map((col) => serializeProcessedArticleValue(col, updatePayload[col]));
	values.push(articleId);

	const sql = `UPDATE ${table} SET ${setClauses} WHERE id = $${values.length}`;
	const queryResult = await db.query(sql, values);
	if (queryResult.rowCount === 0) {
		throw new Error(`Failed to update article ${articleId}: no rows matched`);
	}
}

export async function insertFinalSourceArticle(
	db: DbClient,
	base: InsertArticleData,
	updatePayload: ProcessedArticleUpdate,
): Promise<string> {
	const platformMetadata = updatePayload.platform_metadata ?? base.platformMetadata;
	const entities = updatePayload.entities ?? null;
	const ogImageUrl = Object.hasOwn(updatePayload, 'og_image_url') ? updatePayload.og_image_url : base.ogImageUrl;
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO ${ARTICLES_TABLE} (
			url, title, title_cn, source, published_date, scraped_date, keywords, tags, tokens,
			summary, summary_cn, source_type, content, content_cn, og_image_url, platform_metadata, entities, embedding
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18)
		ON CONFLICT (url) DO NOTHING
		RETURNING id`,
		[
			base.url,
			base.title,
			updatePayload.title_cn ?? null,
			base.source,
			base.publishedDate,
			new Date(),
			updatePayload.keywords ?? base.keywords ?? [],
			updatePayload.tags ?? base.tags ?? [],
			[],
			updatePayload.summary ?? base.summary,
			updatePayload.summary_cn ?? null,
			base.sourceType,
			updatePayload.content ?? base.content,
			updatePayload.content_cn ?? null,
			ogImageUrl,
			platformMetadata ? JSON.stringify(platformMetadata) : null,
			entities ? JSON.stringify(entities) : null,
			updatePayload.embedding ?? null,
		],
	);
	const articleId =
		inserted.rows[0]?.id ??
		(await db.query<{ id: string }>(`SELECT id FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [base.url])).rows[0]?.id;
	if (!articleId) throw new Error(`Failed to insert finalized article for ${base.url}`);
	return articleId;
}

export async function syncArticleEntities(
	db: DbClient,
	articleId: string,
	entities: ArticleEntityInput[],
	source?: string | null,
	platformMetadata?: unknown,
): Promise<void> {
	const normalizedEntities = normalizeArticleEntitiesForStorage(entities, source, platformMetadata);
	const entityIds: string[] = [];
	const existingLinks = await db.query<{ entity_id: string }>(`SELECT entity_id FROM article_entities WHERE article_id = $1`, [articleId]);

	for (const entity of normalizedEntities) {
		const canonical = canonicalizeEntityName(entity.name);
		if (!canonical) continue;

		const result = await db.query(
			`INSERT INTO entities (canonical_name, name, name_cn, type)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (canonical_name) DO UPDATE SET
			   name = EXCLUDED.name,
			   name_cn = EXCLUDED.name_cn,
			   type = EXCLUDED.type,
			   updated_at = NOW()
			 RETURNING id`,
			[canonical, entity.name, entity.name_cn, entity.type],
		);
		const entityId = result.rows[0]?.id;
		if (!entityId) throw new Error(`Failed to sync entity ${canonical}: no entity id returned`);
		entityIds.push(entityId);
	}

	if (entityIds.length) {
		await db.query(`DELETE FROM article_entities WHERE article_id = $1 AND NOT (entity_id = ANY($2::uuid[]))`, [articleId, entityIds]);
	} else {
		await db.query(`DELETE FROM article_entities WHERE article_id = $1`, [articleId]);
	}

	for (const entityId of entityIds) {
		await db.query(`INSERT INTO article_entities (article_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [articleId, entityId]);
	}

	await refreshEntityArticleCounts(db, [...existingLinks.rows.map((row) => row.entity_id), ...entityIds]);

	console.info({
		tag: 'ENTITIES',
		msg: 'Synced',
		articleId,
		inputCount: entities.length,
		count: normalizedEntities.length,
		filteredCount: entities.length - normalizedEntities.length,
	});
}

async function refreshEntityArticleCounts(db: DbClient, entityIds: string[]): Promise<void> {
	const uniqueIds = [...new Set(entityIds)];
	if (!uniqueIds.length) return;
	await db.query(
		`UPDATE entities e
		    SET article_count = counts.article_count
		   FROM (
		     SELECT ids.id, COUNT(ae.article_id)::int AS article_count
		       FROM unnest($1::uuid[]) AS ids(id)
		       LEFT JOIN article_entities ae ON ae.entity_id = ids.id
		      GROUP BY ids.id
		   ) counts
		  WHERE e.id = counts.id`,
		[uniqueIds],
	);
}

export async function repairMissingArticleEntityLinks(
	db: DbClient,
	limit: number,
	options: { before?: Date | string; cursor?: MaintenanceCursor; includeLinked?: boolean; sourceType?: string } = {},
): Promise<{
	scanned: number;
	repaired: number;
	normalized: number;
	skipped: number;
	nextBefore: string | null;
	nextCursor: MaintenanceCursor | null;
}> {
	const cursorDate = options.cursor?.publishedDate ?? options.before ?? null;
	const cursorId = options.cursor?.id ?? null;
	const result = await db.query<ArticleEntityRepairRow>(
		`SELECT a.id, a.source, a.platform_metadata, a.entities, a.published_date
		   FROM ${ARTICLES_TABLE} a
		  WHERE jsonb_typeof(a.entities) = 'array'
		    AND jsonb_array_length(a.entities) > 0
		    AND (
		      $2::timestamptz IS NULL
		      OR a.published_date < $2
		      OR ($3::uuid IS NOT NULL AND a.published_date = $2 AND a.id > $3::uuid)
		    )
		    AND ($4::boolean OR NOT EXISTS (
		      SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id
		    ))
		    AND (
		      $5::text IS NULL
		      OR COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') = $5
		    )
		  ORDER BY a.published_date DESC, a.id ASC
		  LIMIT $1`,
		[limit, cursorDate, cursorId, options.includeLinked === true, options.sourceType ?? null],
	);

	let repaired = 0;
	let normalized = 0;
	let skipped = 0;
	const last = result.rows.length === limit ? result.rows.at(-1) : undefined;
	const nextBefore = last?.published_date ? new Date(last.published_date).toISOString() : null;
	const nextCursor = nextBefore && last ? { id: last.id, publishedDate: nextBefore } : null;

	for (const row of result.rows) {
		if (!Array.isArray(row.entities)) {
			skipped++;
			continue;
		}

		const rawEntities = row.entities.filter(isArticleEntityInput);
		const entities = normalizeArticleEntitiesForStorage(rawEntities, row.source, row.platform_metadata);
		const normalizedJson = JSON.stringify(entities);
		if (!entities.length) {
			await db.query(`UPDATE ${ARTICLES_TABLE} SET entities = '[]'::jsonb WHERE id = $1`, [row.id]);
			skipped++;
			continue;
		}

		if (normalizedJson !== JSON.stringify(row.entities)) {
			await db.query(`UPDATE ${ARTICLES_TABLE} SET entities = $2::jsonb WHERE id = $1`, [row.id, normalizedJson]);
			normalized++;
		}
		await syncArticleEntities(db, row.id, entities, row.source, row.platform_metadata);
		repaired++;
	}

	return {
		scanned: result.rows.length,
		repaired,
		normalized,
		skipped,
		nextBefore,
		nextCursor,
	};
}

export type MissingEntityArticle = { id: string; publishedDate: string | null };

export async function getArticlesMissingEntities(
	db: DbClient,
	limit: number,
	options: { before?: Date | string; cursor?: MaintenanceCursor; includeEmpty?: boolean; sourceType?: string } = {},
): Promise<MissingEntityArticle[]> {
	const cursorDate = options.cursor?.publishedDate ?? options.before ?? null;
	const cursorId = options.cursor?.id ?? null;
	const result = await db.query<{ id: string; published_date: string | Date | null }>(
		`SELECT id, published_date FROM ${ARTICLES_TABLE}
		  WHERE (
		      $2::timestamptz IS NULL
		      OR published_date < $2
		      OR ($3::uuid IS NOT NULL AND published_date = $2 AND id > $3::uuid)
		    )
		    AND (
		      entities IS NULL
		      OR jsonb_typeof(entities) <> 'array'
		      OR (
		        $4::boolean
		        AND CASE
		          WHEN jsonb_typeof(entities) = 'array' THEN jsonb_array_length(entities) = 0
		          ELSE false
		        END
		      )
		    )
		    AND (
		      content IS NOT NULL
		      OR summary IS NOT NULL
		    )
		    AND (
		      $5::text IS NULL
		      OR COALESCE(NULLIF(TRIM(source_type), ''), 'unknown') = $5
		    )
		  ORDER BY published_date DESC, id ASC
		  LIMIT $1`,
		[limit, cursorDate, cursorId, options.includeEmpty === true, options.sourceType ?? null],
	);
	return result.rows.map((row) => ({
		id: row.id,
		publishedDate: row.published_date ? new Date(row.published_date).toISOString() : null,
	}));
}

export async function getEntityQualitySnapshot(
	db: DbClient,
	options: { months: number },
): Promise<{
	overview: {
		totalArticles: number;
		withEntityJson: number;
		emptyEntityJson: number;
		missingEntityJson: number;
		invalidEntityJson: number;
		jsonWithoutLinks: number;
		maxEntitiesPerArticle: number;
		overCapArticles: number;
		totalEntities: number;
		totalEntityLinks: number;
		orphanEntities: number;
		articleCountDrift: number;
		selfSourceExactLinks: number;
		genericEntityLinks: number;
	};
	monthly: Array<{
		month: string;
		totalArticles: number;
		withEntityJson: number;
		emptyEntityJson: number;
		missingOrInvalidEntityJson: number;
		jsonWithoutLinks: number;
		coverage: number;
	}>;
	sourceTypes: Array<{
		sourceType: string;
		totalArticles: number;
		withEntityJson: number;
		emptyEntityJson: number;
		missingOrInvalidEntityJson: number;
		jsonWithoutLinks: number;
		coverage: number;
	}>;
	monthlySourceTypes: Array<{
		month: string;
		sourceType: string;
		totalArticles: number;
		withEntityJson: number;
		emptyEntityJson: number;
		missingOrInvalidEntityJson: number;
		jsonWithoutLinks: number;
		coverage: number;
	}>;
	unknownTypes: Array<{
		type: string;
		count: number;
		examples: Array<{ canonicalName: string; name: string; articleCount: number }>;
	}>;
	topOffenders: {
		selfSource: Array<{ canonicalName: string; name: string; source: string; links: number }>;
		generic: Array<{ canonicalName: string; name: string; links: number }>;
	};
	syncGaps: {
		jsonWithoutLinks: Array<{
			id: string;
			title: string | null;
			source: string | null;
			sourceType: string;
			publishedDate: string | null;
			entityCount: number;
		}>;
	};
	backfill: {
		firstEntityPublishedDate: string | null;
		processableMissingOrEmpty: number;
		processableMissingBeforeFirstEntityDate: number;
		oldestProcessableMissingPublishedDate: string | null;
		newestProcessableMissingPublishedDate: string | null;
		sourceTypes: Array<{
			sourceType: string;
			processableMissingOrEmpty: number;
			processableMissingBeforeFirstEntityDate: number;
			oldestProcessableMissingPublishedDate: string | null;
			newestProcessableMissingPublishedDate: string | null;
		}>;
	};
	database: {
		extensions: {
			pgTrgm: boolean;
			vector: boolean;
		};
		missingRecommendedExtensions: string[];
	};
}> {
	const overview = await db.query<EntityQualityOverviewRow>(
		`WITH article_entity_state AS (
		   SELECT a.id,
		          CASE
		            WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities)
		            ELSE NULL
		          END AS entity_count,
		          a.entities IS NULL AS missing_entities,
		          a.entities IS NOT NULL AND jsonb_typeof(a.entities) <> 'array' AS invalid_entities
		     FROM ${ARTICLES_TABLE} a
		 ),
		 article_link_counts AS (
		   SELECT article_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY article_id
		 ),
		 entity_link_counts AS (
		   SELECT entity_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY entity_id
		 )
		 SELECT COUNT(*)::int AS total_articles,
		        COUNT(*) FILTER (WHERE s.entity_count > 0)::int AS with_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count = 0)::int AS empty_entity_json,
		        COUNT(*) FILTER (WHERE s.missing_entities)::int AS missing_entity_json,
		        COUNT(*) FILTER (WHERE s.invalid_entities)::int AS invalid_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count > 0 AND COALESCE(alc.link_count, 0) = 0)::int AS json_without_links,
		        COALESCE(MAX(s.entity_count), 0)::int AS max_entities_per_article,
		        COUNT(*) FILTER (WHERE s.entity_count > $1)::int AS over_cap_articles,
		        (SELECT COUNT(*)::int FROM entities) AS total_entities,
		        (SELECT COUNT(*)::int FROM article_entities) AS total_entity_links,
		        (SELECT COUNT(*)::int FROM entities e WHERE NOT EXISTS (
		          SELECT 1 FROM article_entities ae WHERE ae.entity_id = e.id
		        )) AS orphan_entities,
		        (SELECT COUNT(*)::int
		           FROM entities e
		           LEFT JOIN entity_link_counts elc ON elc.entity_id = e.id
		          WHERE e.article_count <> COALESCE(elc.link_count, 0)) AS article_count_drift,
		        (SELECT COUNT(*)::int
		           FROM article_entities ae
		           JOIN entities e ON e.id = ae.entity_id
		           JOIN ${ARTICLES_TABLE} a ON a.id = ae.article_id
		          WHERE LOWER(TRIM(a.source)) = e.canonical_name) AS self_source_exact_links,
		        (SELECT COUNT(*)::int
		           FROM article_entities ae
		           JOIN entities e ON e.id = ae.entity_id
		          WHERE e.canonical_name = ANY($2::text[])) AS generic_entity_links
		   FROM article_entity_state s
		   LEFT JOIN article_link_counts alc ON alc.article_id = s.id`,
		[MAX_ENTITIES_PER_ARTICLE, [...GENERIC_ENTITY_CANONICALS]],
	);

	const monthly = await db.query<EntityQualityMonthlyRow>(
		`WITH article_entity_state AS (
		   SELECT a.id,
		          date_trunc('month', a.published_date)::date AS month,
		          CASE
		            WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities)
		            ELSE NULL
		          END AS entity_count,
		          a.entities IS NULL OR jsonb_typeof(a.entities) <> 'array' AS missing_or_invalid_entities
		     FROM ${ARTICLES_TABLE} a
		    WHERE a.published_date >= date_trunc('month', NOW()) - ($1::int * INTERVAL '1 month')
		 ),
		 article_link_counts AS (
		   SELECT article_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY article_id
		 )
		 SELECT to_char(s.month, 'YYYY-MM') AS month,
		        COUNT(*)::int AS total_articles,
		        COUNT(*) FILTER (WHERE s.entity_count > 0)::int AS with_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count = 0)::int AS empty_entity_json,
		        COUNT(*) FILTER (WHERE s.missing_or_invalid_entities)::int AS missing_or_invalid_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count > 0 AND COALESCE(alc.link_count, 0) = 0)::int AS json_without_links
		   FROM article_entity_state s
		   LEFT JOIN article_link_counts alc ON alc.article_id = s.id
		  GROUP BY s.month
		  ORDER BY s.month DESC`,
		[options.months],
	);

	const sourceTypes = await db.query<EntityQualitySourceTypeRow>(
		`WITH article_entity_state AS (
		   SELECT a.id,
		          COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		          CASE
		            WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities)
		            ELSE NULL
		          END AS entity_count,
		          a.entities IS NULL OR jsonb_typeof(a.entities) <> 'array' AS missing_or_invalid_entities
		     FROM ${ARTICLES_TABLE} a
		 ),
		 article_link_counts AS (
		   SELECT article_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY article_id
		 )
		 SELECT s.source_type,
		        COUNT(*)::int AS total_articles,
		        COUNT(*) FILTER (WHERE s.entity_count > 0)::int AS with_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count = 0)::int AS empty_entity_json,
		        COUNT(*) FILTER (WHERE s.missing_or_invalid_entities)::int AS missing_or_invalid_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count > 0 AND COALESCE(alc.link_count, 0) = 0)::int AS json_without_links
		   FROM article_entity_state s
		   LEFT JOIN article_link_counts alc ON alc.article_id = s.id
		  GROUP BY s.source_type
		  ORDER BY total_articles DESC, s.source_type ASC`,
		[],
	);

	const monthlySourceTypes = await db.query<EntityQualityMonthlySourceTypeRow>(
		`WITH article_entity_state AS (
		   SELECT a.id,
		          date_trunc('month', a.published_date)::date AS month,
		          COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		          CASE
		            WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities)
		            ELSE NULL
		          END AS entity_count,
		          a.entities IS NULL OR jsonb_typeof(a.entities) <> 'array' AS missing_or_invalid_entities
		     FROM ${ARTICLES_TABLE} a
		    WHERE a.published_date >= date_trunc('month', NOW()) - ($1::int * INTERVAL '1 month')
		 ),
		 article_link_counts AS (
		   SELECT article_id, COUNT(*)::int AS link_count
		     FROM article_entities
		    GROUP BY article_id
		 )
		 SELECT to_char(s.month, 'YYYY-MM') AS month,
		        s.source_type,
		        COUNT(*)::int AS total_articles,
		        COUNT(*) FILTER (WHERE s.entity_count > 0)::int AS with_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count = 0)::int AS empty_entity_json,
		        COUNT(*) FILTER (WHERE s.missing_or_invalid_entities)::int AS missing_or_invalid_entity_json,
		        COUNT(*) FILTER (WHERE s.entity_count > 0 AND COALESCE(alc.link_count, 0) = 0)::int AS json_without_links
		   FROM article_entity_state s
		   LEFT JOIN article_link_counts alc ON alc.article_id = s.id
		  GROUP BY s.month, s.source_type
		  ORDER BY s.month DESC, total_articles DESC, s.source_type ASC`,
		[options.months],
	);

	const unknownTypes = await db.query<EntityQualityTypeRow>(
		`SELECT type, COUNT(*)::int AS count
		   FROM entities
		  WHERE NOT (type = ANY($1::text[]))
		  GROUP BY type
		  ORDER BY count DESC, type ASC`,
		[[...ENTITY_TYPES]],
	);

	const unknownTypeExamples = await db.query<EntityQualityTypeExampleRow>(
		`SELECT type,
		        canonical_name,
		        name,
		        article_count
		   FROM (
		     SELECT type,
		            canonical_name,
		            name,
		            article_count,
		            row_number() OVER (PARTITION BY type ORDER BY article_count DESC, canonical_name ASC) AS rank
		       FROM entities
		      WHERE NOT (type = ANY($1::text[]))
		   ) ranked
		  WHERE rank <= $2
		  ORDER BY type ASC, rank ASC`,
		[[...ENTITY_TYPES], ENTITY_QUALITY_EXAMPLES_PER_TYPE],
	);
	const examplesByType = new Map<string, Array<{ canonicalName: string; name: string; articleCount: number }>>();
	for (const entry of unknownTypeExamples.rows) {
		const examples = examplesByType.get(entry.type) ?? [];
		examples.push({
			canonicalName: entry.canonical_name,
			name: entry.name,
			articleCount: intValue(entry.article_count),
		});
		examplesByType.set(entry.type, examples);
	}

	const selfSourceOffenders = await db.query<EntityQualitySelfSourceOffenderRow>(
		`SELECT e.canonical_name,
		        e.name,
		        a.source,
		        COUNT(*)::int AS links
		   FROM article_entities ae
		   JOIN entities e ON e.id = ae.entity_id
		   JOIN ${ARTICLES_TABLE} a ON a.id = ae.article_id
		  WHERE LOWER(TRIM(a.source)) = e.canonical_name
		  GROUP BY e.canonical_name, e.name, a.source
		  ORDER BY links DESC, e.canonical_name ASC
		  LIMIT $1`,
		[ENTITY_QUALITY_TOP_LIMIT],
	);

	const genericOffenders = await db.query<EntityQualityGenericOffenderRow>(
		`SELECT e.canonical_name,
		        e.name,
		        COUNT(*)::int AS links
		   FROM article_entities ae
		   JOIN entities e ON e.id = ae.entity_id
		  WHERE e.canonical_name = ANY($1::text[])
		  GROUP BY e.canonical_name, e.name
		  ORDER BY links DESC, e.canonical_name ASC
		  LIMIT $2`,
		[[...GENERIC_ENTITY_CANONICALS], ENTITY_QUALITY_TOP_LIMIT],
	);

	const jsonWithoutLinkExamples = await db.query<EntityQualitySyncGapRow>(
		`SELECT a.id,
		        a.title,
		        a.source,
		        COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		        a.published_date,
		        jsonb_array_length(a.entities)::int AS entity_count
		   FROM ${ARTICLES_TABLE} a
		  WHERE jsonb_typeof(a.entities) = 'array'
		    AND jsonb_array_length(a.entities) > 0
		    AND NOT EXISTS (
		      SELECT 1 FROM article_entities ae WHERE ae.article_id = a.id
		    )
		  ORDER BY a.published_date DESC
		  LIMIT $1`,
		[ENTITY_QUALITY_TOP_LIMIT],
	);

	const backfill = await db.query<EntityQualityBackfillRow>(
		`WITH first_entity AS (
		   SELECT MIN(published_date) AS first_entity_published_date
		     FROM ${ARTICLES_TABLE}
		    WHERE jsonb_typeof(entities) = 'array'
		      AND jsonb_array_length(entities) > 0
		 ),
		 processable_backlog AS (
		   SELECT a.published_date
		     FROM ${ARTICLES_TABLE} a
		    WHERE (a.content IS NOT NULL OR a.summary IS NOT NULL)
		      AND (
		        a.entities IS NULL
		        OR jsonb_typeof(a.entities) <> 'array'
		        OR CASE
		          WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities) = 0
		          ELSE false
		        END
		      )
		 )
		 SELECT f.first_entity_published_date,
		        COUNT(p.published_date)::int AS processable_missing_or_empty,
		        COUNT(*) FILTER (
		          WHERE f.first_entity_published_date IS NOT NULL
		            AND p.published_date < f.first_entity_published_date
		        )::int AS processable_missing_before_first_entity,
		        MIN(p.published_date) AS oldest_processable_missing_published_date,
		        MAX(p.published_date) AS newest_processable_missing_published_date
		   FROM first_entity f
		   LEFT JOIN processable_backlog p ON true
		  GROUP BY f.first_entity_published_date`,
		[],
	);

	const backfillSourceTypes = await db.query<EntityQualityBackfillSourceTypeRow>(
		`WITH first_entity AS (
		   SELECT MIN(published_date) AS first_entity_published_date
		     FROM ${ARTICLES_TABLE}
		    WHERE jsonb_typeof(entities) = 'array'
		      AND jsonb_array_length(entities) > 0
		 ),
		 processable_backlog AS (
		   SELECT COALESCE(NULLIF(TRIM(a.source_type), ''), 'unknown') AS source_type,
		          a.published_date
		     FROM ${ARTICLES_TABLE} a
		    WHERE (a.content IS NOT NULL OR a.summary IS NOT NULL)
		      AND (
		        a.entities IS NULL
		        OR jsonb_typeof(a.entities) <> 'array'
		        OR CASE
		          WHEN jsonb_typeof(a.entities) = 'array' THEN jsonb_array_length(a.entities) = 0
		          ELSE false
		        END
		      )
		 )
		 SELECT p.source_type,
		        COUNT(*)::int AS processable_missing_or_empty,
		        COUNT(*) FILTER (
		          WHERE f.first_entity_published_date IS NOT NULL
		            AND p.published_date < f.first_entity_published_date
		        )::int AS processable_missing_before_first_entity,
		        MIN(p.published_date) AS oldest_processable_missing_published_date,
		        MAX(p.published_date) AS newest_processable_missing_published_date
		   FROM processable_backlog p
		   CROSS JOIN first_entity f
		  GROUP BY p.source_type
		  ORDER BY processable_missing_or_empty DESC, p.source_type ASC`,
		[],
	);

	const recommendedExtensions = ['pg_trgm', 'vector'];
	const extensions = await db.query<EntityQualityExtensionRow>(
		`SELECT extname
		   FROM pg_extension
		  WHERE extname = ANY($1::text[])
		  ORDER BY extname ASC`,
		[recommendedExtensions],
	);
	const installedExtensions = new Set(extensions.rows.map((entry) => entry.extname));
	const row = overview.rows[0];
	return {
		overview: {
			totalArticles: intValue(row?.total_articles),
			withEntityJson: intValue(row?.with_entity_json),
			emptyEntityJson: intValue(row?.empty_entity_json),
			missingEntityJson: intValue(row?.missing_entity_json),
			invalidEntityJson: intValue(row?.invalid_entity_json),
			jsonWithoutLinks: intValue(row?.json_without_links),
			maxEntitiesPerArticle: intValue(row?.max_entities_per_article),
			overCapArticles: intValue(row?.over_cap_articles),
			totalEntities: intValue(row?.total_entities),
			totalEntityLinks: intValue(row?.total_entity_links),
			orphanEntities: intValue(row?.orphan_entities),
			articleCountDrift: intValue(row?.article_count_drift),
			selfSourceExactLinks: intValue(row?.self_source_exact_links),
			genericEntityLinks: intValue(row?.generic_entity_links),
		},
		monthly: monthly.rows.map((entry) => {
			const totalArticles = intValue(entry.total_articles);
			const withEntityJson = intValue(entry.with_entity_json);
			return {
				month: entry.month,
				totalArticles,
				withEntityJson,
				emptyEntityJson: intValue(entry.empty_entity_json),
				missingOrInvalidEntityJson: intValue(entry.missing_or_invalid_entity_json),
				jsonWithoutLinks: intValue(entry.json_without_links),
				coverage: totalArticles ? withEntityJson / totalArticles : 0,
			};
		}),
		sourceTypes: sourceTypes.rows.map((entry) => {
			const totalArticles = intValue(entry.total_articles);
			const withEntityJson = intValue(entry.with_entity_json);
			return {
				sourceType: entry.source_type,
				totalArticles,
				withEntityJson,
				emptyEntityJson: intValue(entry.empty_entity_json),
				missingOrInvalidEntityJson: intValue(entry.missing_or_invalid_entity_json),
				jsonWithoutLinks: intValue(entry.json_without_links),
				coverage: totalArticles ? withEntityJson / totalArticles : 0,
			};
		}),
		monthlySourceTypes: monthlySourceTypes.rows.map((entry) => {
			const totalArticles = intValue(entry.total_articles);
			const withEntityJson = intValue(entry.with_entity_json);
			return {
				month: entry.month,
				sourceType: entry.source_type,
				totalArticles,
				withEntityJson,
				emptyEntityJson: intValue(entry.empty_entity_json),
				missingOrInvalidEntityJson: intValue(entry.missing_or_invalid_entity_json),
				jsonWithoutLinks: intValue(entry.json_without_links),
				coverage: totalArticles ? withEntityJson / totalArticles : 0,
			};
		}),
		unknownTypes: unknownTypes.rows.map((entry) => ({
			type: entry.type,
			count: intValue(entry.count),
			examples: examplesByType.get(entry.type) ?? [],
		})),
		topOffenders: {
			selfSource: selfSourceOffenders.rows.map((entry) => ({
				canonicalName: entry.canonical_name,
				name: entry.name,
				source: entry.source,
				links: intValue(entry.links),
			})),
			generic: genericOffenders.rows.map((entry) => ({
				canonicalName: entry.canonical_name,
				name: entry.name,
				links: intValue(entry.links),
			})),
		},
		syncGaps: {
			jsonWithoutLinks: jsonWithoutLinkExamples.rows.map((entry) => ({
				id: entry.id,
				title: entry.title,
				source: entry.source,
				sourceType: entry.source_type,
				publishedDate: isoDateValue(entry.published_date),
				entityCount: intValue(entry.entity_count),
			})),
		},
		backfill: {
			firstEntityPublishedDate: isoDateValue(backfill.rows[0]?.first_entity_published_date),
			processableMissingOrEmpty: intValue(backfill.rows[0]?.processable_missing_or_empty),
			processableMissingBeforeFirstEntityDate: intValue(backfill.rows[0]?.processable_missing_before_first_entity),
			oldestProcessableMissingPublishedDate: isoDateValue(backfill.rows[0]?.oldest_processable_missing_published_date),
			newestProcessableMissingPublishedDate: isoDateValue(backfill.rows[0]?.newest_processable_missing_published_date),
			sourceTypes: backfillSourceTypes.rows.map((entry) => ({
				sourceType: entry.source_type,
				processableMissingOrEmpty: intValue(entry.processable_missing_or_empty),
				processableMissingBeforeFirstEntityDate: intValue(entry.processable_missing_before_first_entity),
				oldestProcessableMissingPublishedDate: isoDateValue(entry.oldest_processable_missing_published_date),
				newestProcessableMissingPublishedDate: isoDateValue(entry.newest_processable_missing_published_date),
			})),
		},
		database: {
			extensions: {
				pgTrgm: installedExtensions.has('pg_trgm'),
				vector: installedExtensions.has('vector'),
			},
			missingRecommendedExtensions: recommendedExtensions.filter((extension) => !installedExtensions.has(extension)),
		},
	};
}

export async function pruneOrphanEntities(db: DbClient, limit: number): Promise<{ deleted: number }> {
	const result = await db.query<{ deleted: number }>(
		`WITH orphan_entities AS (
		   SELECT e.id
		     FROM entities e
		    WHERE NOT EXISTS (
		      SELECT 1 FROM article_entities ae WHERE ae.entity_id = e.id
		    )
		    ORDER BY e.updated_at ASC
		    LIMIT $1
		 ),
		 deleted_entities AS (
		   DELETE FROM entities e
		    USING orphan_entities o
		    WHERE e.id = o.id
		    RETURNING e.id
		 )
		 SELECT COUNT(*)::int AS deleted FROM deleted_entities`,
		[limit],
	);
	return { deleted: result.rows[0]?.deleted ?? 0 };
}

export type ExistingArticleRecord = {
	id: string;
	url: string;
	source: string;
	source_type: string;
	summary_cn: string | null;
};

export async function getExistingArticlesByUrl(db: DbClient, urls: string[], batchSize = 50): Promise<ExistingArticleRecord[]> {
	const records: ExistingArticleRecord[] = [];
	if (urls.length === 0) return records;

	for (let i = 0; i < urls.length; i += batchSize) {
		const batch = urls.slice(i, i + batchSize);
		const result = await db.query<ExistingArticleRecord>(
			`SELECT id, url, source, source_type, summary_cn FROM ${ARTICLES_TABLE} WHERE url = ANY($1)`,
			[batch],
		);
		records.push(...result.rows);
	}

	return records;
}

export type ArticleSourceUpdate = {
	url: string;
	source: string;
	sourceType?: string;
	platformMetadata?: unknown;
};

export async function updateArticleSourceByUrl(db: DbClient, update: ArticleSourceUpdate): Promise<void> {
	const updateFields: string[] = ['source = $1'];
	const updateValues: unknown[] = [update.source];
	let paramIndex = 2;

	if (update.sourceType !== undefined) {
		updateFields.push(`source_type = $${paramIndex++}`);
		updateValues.push(update.sourceType);
	}
	if (update.platformMetadata !== undefined) {
		updateFields.push(`platform_metadata = $${paramIndex++}`);
		updateValues.push(update.platformMetadata === null ? null : JSON.stringify(update.platformMetadata));
	}

	updateValues.push(update.url);
	await db.query(`UPDATE ${ARTICLES_TABLE} SET ${updateFields.join(', ')} WHERE url = $${paramIndex}`, updateValues);
}

export type ArticleReprocessingTextUpdate = {
	summary: string;
	content: string;
	platformMetadata: unknown;
};

export async function updateArticleTextForReprocessing(
	db: DbClient,
	articleId: string,
	update: ArticleReprocessingTextUpdate,
): Promise<void> {
	await db.query(
		`UPDATE ${ARTICLES_TABLE}
		 SET summary = $1,
		     content = $2,
		     platform_metadata = $3,
		     summary_cn = NULL,
		     content_cn = NULL,
		     title_cn = NULL,
		     embedding = NULL
		 WHERE id = $4`,
		[update.summary, update.content, JSON.stringify(update.platformMetadata), articleId],
	);
}

export async function getExistingUrls(db: DbClient, urls: string[], table: string = ARTICLES_TABLE, batchSize = 50): Promise<Set<string>> {
	const existing = new Set<string>();
	if (urls.length === 0) return existing;
	for (let i = 0; i < urls.length; i += batchSize) {
		const batch = urls.slice(i, i + batchSize);
		const result = await db.query(`SELECT url FROM ${table} WHERE url = ANY($1)`, [batch]);
		for (const row of result.rows as { url: string }[]) {
			existing.add(normalizeUrl(row.url));
		}
	}
	return existing;
}

export type IncompleteWorkflowTargetIds = {
	articleIds: string[];
	userFileIds: string[];
};

export async function getIncompleteWorkflowTargetIds(db: DbClient, since: Date | string): Promise<IncompleteWorkflowTargetIds> {
	const articleResult = await db.query<{ id: string }>(
		`SELECT id FROM ${ARTICLES_TABLE}
		 WHERE scraped_date >= $1
		   AND (
		     title_cn IS NULL
		     OR summary_cn IS NULL
		     OR embedding IS NULL
		     OR (content IS NOT NULL AND length(content) >= 120 AND content_cn IS NULL)
		   )`,
		[since],
	);

	const userFileResult = await db.query<{ id: string }>(
		`SELECT id FROM ${USER_FILES_TABLE}
		 WHERE created_at >= $1
		   AND (
		     (resource_kind = 'url' AND (
		       title_cn IS NULL
		       OR summary_cn IS NULL
		       OR embedding IS NULL
		       OR (extracted_text IS NOT NULL AND length(extracted_text) >= 120 AND content_cn IS NULL)
		     ))
		     OR (
		       resource_kind = 'blob'
		       AND file_type = 'application/pdf'
		       AND (metadata->'extraction'->>'status') IS DISTINCT FROM 'failed'
		       AND (
		         extracted_text IS NULL
		         OR embedding IS NULL
		         OR (extracted_text IS NOT NULL AND length(extracted_text) >= 120 AND content_cn IS NULL)
		       )
		     )
		   )`,
		[since],
	);

	return {
		articleIds: [...new Set(articleResult.rows.map((row) => row.id))],
		userFileIds: [...new Set(userFileResult.rows.map((row) => row.id))],
	};
}
