import type { Article } from '@core-shared/types';
import { type CoreDb, withCoreDb } from '@db/client';
import { entities, entityTranslations, resourceEntities, resources, resourceTranslations } from '@db/schema';
import { canonicalizeEntityName, normalizeResourceEntitiesForStorage, type ResourceEntityInput } from '@entities/normalize';
import { and, eq, inArray, not, type SQL, sql } from 'drizzle-orm';
import {
	RESOURCE_CATEGORIES,
	RESOURCE_TYPES,
	type ResourceCategory,
	type ResourceTranslationSource,
	type ResourceType,
} from '../../resources/types';

type ArticleForProcessing = Article & { has_content?: boolean };

interface ArticleStoreRow {
	id: string;
	title: string | null;
	title_cn: string | null;
	summary: string | null;
	summary_cn: string | null;
	content: string | null;
	url: string | null;
	og_image_url: string | null;
	source: string | null;
	resource_type: string | null;
	published_date: Date | string | null;
	tags: string[];
	keywords: string[];
	platform_metadata: unknown;
	enrichment_status?: string;
	has_content?: boolean;
	storage_key?: string | null;
	file_type?: string;
	normalized_source_url?: string | null;
	resource_kind?: string;
	origin_type?: string;
}

export async function loadResourceForProcessing(env: CoreEnv, resourceId: string, shell = false): Promise<ArticleForProcessing> {
	return withCoreDb(env, async (db) => {
		const row = await loadStoredResourceRow(db, resourceId, shell);
		if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
		return row;
	});
}

export async function isResourceEnrichmentComplete(env: CoreEnv, resourceId: string): Promise<boolean> {
	return withCoreDb(env, async (db) => {
		const row = (
			await db
				.select({
					complete: sql<boolean>`${resources.enrichmentStatus} = 'enriched'
						AND ${resources.embedding} IS NOT NULL`,
				})
				.from(resources)
				.where(eq(resources.id, resourceId))
				.limit(1)
		)[0];
		if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
		return row.complete;
	});
}

async function loadStoredResourceRow(db: CoreDb, resourceId: string, shell: boolean): Promise<ArticleForProcessing | undefined> {
	const result = await db.execute(sql`
		SELECT
			r.id::text AS id,
			original.title AS title,
			zh.title AS title_cn,
			original.summary AS summary,
			zh.summary AS summary_cn,
			${shell ? sql`NULL::text` : sql`original.content`} AS content,
			${shell ? sql`original.content IS NOT NULL AND length(original.content) > 0` : sql`NULL::boolean`} AS has_content,
			r.url AS url,
			r.og_image_url AS og_image_url,
			COALESCE(r.type, '') AS source,
			r.type AS resource_type,
			r.published_date AS published_date,
			r.tags AS tags,
			COALESCE(original.keywords, '{}'::text[]) AS keywords,
			r.platform_metadata AS platform_metadata,
			r.enrichment_status AS enrichment_status,
			r.storage_key AS storage_key,
			r.file_type AS file_type,
			r.normalized_url AS normalized_source_url,
			CASE WHEN r.storage_key IS NULL THEN 'url' ELSE 'blob' END AS resource_kind
		FROM resources r
		LEFT JOIN resource_translations original
		  ON original.resource_id = r.id AND original.lang = r.original_lang
		LEFT JOIN resource_translations zh
		  ON zh.resource_id = r.id AND zh.lang = 'zh-Hant'
		WHERE r.id = ${resourceId}::uuid
		LIMIT 1
	`);
	const row = (result.rows as unknown as ArticleStoreRow[])[0];
	return row ? articleStoreRowToProcessing(row) : undefined;
}

function articleStoreRowToProcessing(row: ArticleStoreRow): ArticleForProcessing {
	const article: ArticleForProcessing = {
		id: row.id,
		title: row.title ?? '',
		title_cn: row.title_cn,
		summary: row.summary,
		summary_cn: row.summary_cn,
		content: row.content,
		url: row.url ?? '',
		og_image_url: row.og_image_url,
		source: row.source ?? '',
		published_date: formatPublishedDate(row.published_date),
		tags: row.tags,
		keywords: row.keywords,
		resource_type: row.resource_type ?? undefined,
		platform_metadata: (row.platform_metadata ?? undefined) as Article['platform_metadata'],
	};
	if (typeof row.has_content === 'boolean') article.has_content = row.has_content;
	if ('storage_key' in row) article.storage_key = row.storage_key ?? null;
	if (row.file_type) article.file_type = row.file_type;
	if ('normalized_source_url' in row) article.normalized_source_url = row.normalized_source_url ?? null;
	if (row.resource_kind) article.resource_kind = row.resource_kind;
	if (row.origin_type) article.origin_type = row.origin_type;
	return article;
}

function formatPublishedDate(value: Date | string | null): string {
	if (value instanceof Date) return value.toISOString();
	return value ?? '';
}

export interface SourceResourceDraft {
	url: string;
	title: string;
	source: string;
	publishedDate: Date | string;
	summary: string;
	resourceType: string;
	content: string | null;
	platformMetadata: unknown | null;
	keywords?: string[];
	tags?: string[];
}

type ResourceMirrorOrigin = 'source' | 'resource';
type ResourceEnrichmentStatus = 'pending' | 'enriched' | 'failed';

const DEFAULT_RESOURCE_LANG = 'en';
const ZH_HANT_RESOURCE_LANG = 'zh-Hant';

interface ResourceMirrorRecord {
	id: string;
	type: ResourceType;
	scope: 'corpus' | 'private';
	url: string | null;
	normalizedUrl: string | null;
	storageKey: string | null;
	fileType: string | null;
	originalLang: string;
	title: string | null;
	titleCn: string | null;
	summary: string | null;
	summaryCn: string | null;
	content: string | null;
	contentCn: string | null;
	publishedDate: Date | null;
	scrapedDate: Date;
	keywords: string[];
	tags: string[];
	category: ResourceCategory | null;
	entitiesJson: string | null;
	ogImageUrl: string | null;
	platformMetadataJson: string | null;
	embedding: string | null;
	enrichmentStatus: ResourceEnrichmentStatus;
}

interface ResourceTranslationRecord {
	resourceId: string;
	lang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	keywords: string[];
	source: ResourceTranslationSource;
}

function stringArrayValue(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw new Error(`Invalid ${field}: expected string[]`);
	}
	return value;
}

function dateValue(value: unknown, field: string): Date {
	const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
	if (!date || Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}: expected date`);
	return date;
}

function nullableVector(value: unknown, field: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new Error(`Invalid ${field}: expected vector string`);
	return value;
}

/**
 * Core sink dedup policy:
 * - Source resources are globally unique by normalized URL. Discovery may
 *   pre-query with getExistingResourcesByUrl, but pending resource upsert is
 *   the authoritative ON CONFLICT guard.
 * - Stored enrichment targets are canonical resources only.
 */
export async function updateResourceAfterProcessing(
	db: CoreDb,
	resourceId: string,
	article: Article,
	updatePayload: Record<string, unknown>,
): Promise<string> {
	const record = resourceMirrorRecord('resource', resourceId, article, updatePayload);
	const result = await db.execute(sql`
		UPDATE resources
		   SET type = ${record.type},
		       url = COALESCE(${record.url}, resources.url),
		       normalized_url = COALESCE(${record.normalizedUrl}, resources.normalized_url),
		       storage_key = COALESCE(${record.storageKey}, resources.storage_key),
		       file_type = COALESCE(${record.fileType}, resources.file_type),
		       original_lang = ${record.originalLang},
		       published_date = COALESCE(${record.publishedDate}, resources.published_date),
		       scraped_date = ${record.scrapedDate},
		       tags = CASE WHEN cardinality(${record.tags}::text[]) > 0 THEN ${record.tags}::text[] ELSE resources.tags END,
		       category = COALESCE(${record.category}, resources.category),
		       entities = COALESCE(${record.entitiesJson}::jsonb, resources.entities),
		       og_image_url = COALESCE(NULLIF(${record.ogImageUrl}, ''), resources.og_image_url),
		       platform_metadata = COALESCE(${record.platformMetadataJson}::jsonb, resources.platform_metadata),
		       embedding = COALESCE(${record.embedding}::vector, resources.embedding),
		       enrichment_status = 'enriched',
		       updated_at = now()
		 WHERE id = ${resourceId}::uuid
		 RETURNING id::text AS id
	`);
	const updatedId = (result.rows as Array<{ id?: string }>)[0]?.id;
	if (!updatedId) throw new Error(`Failed to update resource ${resourceId}: no rows matched`);
	await syncResourceTranslations(db, updatedId, record);
	return updatedId;
}

function preparedRecordToArticle(base: SourceResourceDraft): Article {
	return {
		id: base.url,
		title: base.title,
		title_cn: null,
		summary: base.summary,
		summary_cn: null,
		content: base.content,
		content_cn: null,
		url: base.url,
		og_image_url: null,
		source: base.source,
		published_date: formatPublishedDate(base.publishedDate),
		tags: base.tags ?? [],
		keywords: base.keywords ?? [],
		resource_type: base.resourceType,
		platform_metadata: (base.platformMetadata ?? undefined) as Article['platform_metadata'],
	};
}

export async function upsertPendingSourceResource(db: CoreDb, base: SourceResourceDraft): Promise<string> {
	const record = resourceMirrorRecord('source', crypto.randomUUID(), preparedRecordToArticle(base), {}, 'pending');
	const result = await db.execute(resourceUpsertStatement(record));
	const resourceId = (result.rows as Array<{ id?: string }>)[0]?.id;
	if (!resourceId) throw new Error(`Failed to upsert pending resource for ${base.url}`);
	await syncResourceTranslations(db, resourceId, record);
	return resourceId;
}

function resourceMirrorRecord(
	origin: ResourceMirrorOrigin,
	resourceId: string,
	article: Article,
	updatePayload: Record<string, unknown>,
	enrichmentStatus: ResourceEnrichmentStatus = 'enriched',
): ResourceMirrorRecord {
	const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata ?? null;
	const storedPlatformMetadata = platformMetadataWithSourceName(platformMetadata, article.source);
	const fileType = stringOrNull(article.file_type);
	const url = cleanString(updatePayload.url ?? article.url);
	const normalizedUrl = origin === 'resource' ? cleanString(article.normalized_source_url ?? article.url) : url;
	const tags = stringArrayValue(updatePayload.tags ?? article.tags ?? [], 'tags');
	const keywords = stringArrayValue(updatePayload.keywords ?? article.keywords ?? [], 'keywords');
	const title = cleanString(updatePayload.title ?? article.title);
	const titleCn = cleanString(updatePayload.title_cn ?? article.title_cn);
	const summary = cleanString(updatePayload.summary ?? article.summary);
	const summaryCn = cleanString(updatePayload.summary_cn ?? article.summary_cn);
	const content = cleanString(updatePayload.content ?? article.content);
	const contentCn = cleanString(updatePayload.content_cn ?? article.content_cn);
	return {
		id: resourceId,
		type: deriveResourceType({
			origin,
			platformMetadata,
			resourceType: stringOrNull(updatePayload.resource_type ?? article.resource_type),
			fileType,
			resourceKind: article.resource_kind ?? null,
		}),
		scope: origin === 'source' || article.resource_kind === 'url' ? 'corpus' : 'private',
		url,
		normalizedUrl,
		storageKey: cleanString(article.storage_key),
		fileType,
		originalLang: deriveOriginalLang({ title, summary, content, titleCn, summaryCn, contentCn }),
		title,
		titleCn,
		summary,
		summaryCn,
		content,
		contentCn,
		publishedDate: optionalDateValue(updatePayload.published_date ?? article.published_date, 'published_date'),
		scrapedDate: new Date(),
		keywords,
		tags,
		category: deriveResourceCategory(storedPlatformMetadata, tags),
		entitiesJson: jsonbParam(updatePayload.entities ?? null),
		ogImageUrl: cleanString(updatePayload.og_image_url ?? article.og_image_url),
		platformMetadataJson: jsonbParam(storedPlatformMetadata),
		embedding: nullableVector(updatePayload.embedding, 'embedding'),
		enrichmentStatus,
	};
}

function platformMetadataWithSourceName(platformMetadata: unknown, source: string | null | undefined): unknown {
	const sourceName = cleanString(source);
	if (!sourceName) return platformMetadata;
	if (platformMetadata && typeof platformMetadata === 'object' && !Array.isArray(platformMetadata)) {
		return { ...(platformMetadata as Record<string, unknown>), sourceName };
	}
	return { type: 'default', fetchedAt: new Date().toISOString(), data: null, sourceName };
}

function resourceUpsertStatement(record: ResourceMirrorRecord): SQL {
	if (record.normalizedUrl) {
		return resourceInsertStatement(
			record,
			sql`ON CONFLICT (normalized_url) WHERE normalized_url IS NOT NULL DO UPDATE SET ${resourceConflictSetSql()}`,
		);
	}
	if (record.storageKey) {
		return resourceInsertStatement(record, sql`ON CONFLICT (storage_key) DO UPDATE SET ${resourceConflictSetSql()}`);
	}
	return resourceInsertStatement(record, sql`ON CONFLICT (id) DO UPDATE SET ${resourceConflictSetSql()}`);
}

function resourceInsertStatement(record: ResourceMirrorRecord, conflictSql: SQL): SQL {
	return sql`
		INSERT INTO resources (
			id, type, scope, url, normalized_url, storage_key, file_type,
			original_lang, published_date, scraped_date, tags, category, entities,
			og_image_url, platform_metadata, embedding, enrichment_status,
			created_at, updated_at
		)
		VALUES (
			${record.id}::uuid,
			${record.type},
			${record.scope},
			${record.url},
			${record.normalizedUrl},
			${record.storageKey},
			${record.fileType},
			${record.originalLang},
			${record.publishedDate},
			${record.scrapedDate},
			${record.tags}::text[],
			${record.category},
			${record.entitiesJson}::jsonb,
			${record.ogImageUrl},
			${record.platformMetadataJson}::jsonb,
			${record.embedding}::vector,
			${record.enrichmentStatus},
			now(),
			now()
		)
		${conflictSql}
		RETURNING id::text AS id
	`;
}

function resourceConflictSetSql(): SQL {
	return sql`
		type = excluded.type,
		scope = CASE
			WHEN resources.scope = 'corpus' OR excluded.scope = 'private' THEN resources.scope
			ELSE excluded.scope
		END,
		url = COALESCE(excluded.url, resources.url),
		storage_key = COALESCE(excluded.storage_key, resources.storage_key),
		file_type = COALESCE(excluded.file_type, resources.file_type),
		original_lang = excluded.original_lang,
		published_date = COALESCE(excluded.published_date, resources.published_date),
		scraped_date = COALESCE(excluded.scraped_date, resources.scraped_date),
		tags = CASE WHEN cardinality(excluded.tags) > 0 THEN excluded.tags ELSE resources.tags END,
		category = COALESCE(excluded.category, resources.category),
		entities = COALESCE(excluded.entities, resources.entities),
		og_image_url = COALESCE(NULLIF(excluded.og_image_url, ''), resources.og_image_url),
		platform_metadata = COALESCE(excluded.platform_metadata, resources.platform_metadata),
		embedding = COALESCE(excluded.embedding, resources.embedding),
		enrichment_status = CASE
			WHEN excluded.enrichment_status = 'pending' AND resources.enrichment_status = 'enriched'
				THEN resources.enrichment_status
			ELSE excluded.enrichment_status
		END,
		updated_at = now()
	`;
}

async function syncResourceTranslations(db: CoreDb, resourceId: string, record: ResourceMirrorRecord): Promise<void> {
	for (const translation of resourceTranslationRecords(resourceId, record)) {
		await db
			.insert(resourceTranslations)
			.values(translation)
			.onConflictDoUpdate({
				target: [resourceTranslations.resourceId, resourceTranslations.lang],
				set: {
					title: sql`COALESCE(NULLIF(excluded.title, ''), ${resourceTranslations.title})`,
					summary: sql`COALESCE(NULLIF(excluded.summary, ''), ${resourceTranslations.summary})`,
					content: sql`COALESCE(NULLIF(excluded.content, ''), ${resourceTranslations.content})`,
					keywords: sql`CASE WHEN cardinality(excluded.keywords) > 0 THEN excluded.keywords ELSE ${resourceTranslations.keywords} END`,
					source: sql`CASE WHEN ${resourceTranslations.source} = 'original' THEN ${resourceTranslations.source} ELSE excluded.source END`,
					updatedAt: sql`now()`,
				},
			});
	}
	await db
		.update(resourceTranslations)
		.set({ source: 'machine', updatedAt: sql`now()` })
		.where(
			and(
				eq(resourceTranslations.resourceId, resourceId),
				not(eq(resourceTranslations.lang, record.originalLang)),
				eq(resourceTranslations.source, 'original'),
			),
		);
}

function resourceTranslationRecords(resourceId: string, record: ResourceMirrorRecord): ResourceTranslationRecord[] {
	const originalUsesZhHant = record.originalLang === ZH_HANT_RESOURCE_LANG;
	const translations: ResourceTranslationRecord[] = [
		{
			resourceId,
			lang: record.originalLang,
			title: originalUsesZhHant ? record.titleCn : record.title,
			summary: originalUsesZhHant ? record.summaryCn : record.summary,
			content: originalUsesZhHant ? record.contentCn : record.content,
			keywords: record.keywords,
			source: 'original',
		},
	];

	if (!originalUsesZhHant && hasLocalizedText(record.titleCn, record.summaryCn, record.contentCn)) {
		translations.push({
			resourceId,
			lang: ZH_HANT_RESOURCE_LANG,
			title: record.titleCn,
			summary: record.summaryCn,
			content: record.contentCn,
			keywords: record.keywords,
			source: 'machine',
		});
	}

	return translations;
}

function deriveOriginalLang(fields: {
	title: string | null;
	summary: string | null;
	content: string | null;
	titleCn: string | null;
	summaryCn: string | null;
	contentCn: string | null;
}): string {
	return !hasLocalizedText(fields.title, fields.summary, fields.content) &&
		hasLocalizedText(fields.titleCn, fields.summaryCn, fields.contentCn)
		? ZH_HANT_RESOURCE_LANG
		: DEFAULT_RESOURCE_LANG;
}

function hasLocalizedText(...values: Array<string | null>): boolean {
	return values.some((value) => !!value && value.trim().length > 0);
}

function cleanString(value: unknown): string | null {
	const str = stringOrNull(value);
	if (!str) return null;
	const trimmed = str.trim();
	return trimmed.length ? trimmed : null;
}

function stringOrNull(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new Error(`Invalid resource field: expected string`);
	return value;
}

function optionalDateValue(value: unknown, field: string): Date | null {
	if (value === null || value === undefined || value === '') return null;
	return dateValue(value, field);
}

function jsonbParam(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	return JSON.stringify(value);
}

function deriveResourceType(input: {
	origin: ResourceMirrorOrigin;
	platformMetadata: unknown;
	resourceType: string | null;
	fileType: string | null;
	resourceKind: string | null;
}): ResourceType {
	const metadataType = platformMetadataType(input.platformMetadata);
	if (metadataType) return metadataType;
	if (isResourceType(input.resourceType)) return input.resourceType;
	if (input.fileType === 'application/pdf') return 'pdf';
	if (input.fileType?.startsWith('image/')) return 'image';
	if (input.origin === 'resource' && input.resourceKind === 'url') return 'web';
	return input.origin === 'resource' ? 'file' : 'web';
}

function platformMetadataType(value: unknown): ResourceType | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const type = (value as { type?: unknown }).type;
	return isResourceType(type) ? type : null;
}

function deriveResourceCategory(platformMetadata: unknown, tags: string[]): ResourceCategory | null {
	if (platformMetadata && typeof platformMetadata === 'object' && !Array.isArray(platformMetadata)) {
		const category = (platformMetadata as { classification?: { category?: unknown } }).classification?.category;
		if (isResourceCategory(category)) return category;
	}
	return tags.find(isResourceCategory) ?? null;
}

function isResourceType(value: unknown): value is ResourceType {
	return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

function isResourceCategory(value: unknown): value is ResourceCategory {
	return typeof value === 'string' && (RESOURCE_CATEGORIES as readonly string[]).includes(value);
}

export async function syncResourceEntities(
	db: CoreDb,
	resourceId: string,
	inputEntities: ResourceEntityInput[],
	source?: string | null,
	platformMetadata?: unknown,
): Promise<void> {
	const existingLinks = await db
		.select({ entityId: resourceEntities.entityId })
		.from(resourceEntities)
		.where(eq(resourceEntities.resourceId, resourceId));
	const { normalizedEntities, entityIds } = await upsertEntityIds(db, inputEntities, source, platformMetadata);

	if (entityIds.length) {
		await db
			.delete(resourceEntities)
			.where(and(eq(resourceEntities.resourceId, resourceId), not(inArray(resourceEntities.entityId, entityIds))));
	} else {
		await db.delete(resourceEntities).where(eq(resourceEntities.resourceId, resourceId));
	}

	for (const entityId of entityIds) {
		await db.insert(resourceEntities).values({ resourceId, entityId }).onConflictDoNothing();
	}

	await refreshEntityResourceCounts(db, [...existingLinks.map((row) => row.entityId), ...entityIds]);

	console.info({
		tag: 'ENTITIES',
		msg: 'Synced resource links',
		resourceId,
		inputCount: inputEntities.length,
		count: normalizedEntities.length,
		filteredCount: inputEntities.length - normalizedEntities.length,
	});
}

async function upsertEntityIds(
	db: CoreDb,
	inputEntities: ResourceEntityInput[],
	source?: string | null,
	platformMetadata?: unknown,
): Promise<{ normalizedEntities: ResourceEntityInput[]; entityIds: string[] }> {
	const normalizedEntities = normalizeResourceEntitiesForStorage(inputEntities, source, platformMetadata);
	const entityIds: string[] = [];

	for (const entity of normalizedEntities) {
		const canonical = canonicalizeEntityName(entity.name);
		if (!canonical) continue;

		const [row] = await db
			.insert(entities)
			.values({ canonicalName: canonical, name: entity.name, nameCn: entity.name_cn, type: entity.type })
			.onConflictDoUpdate({
				target: entities.canonicalName,
				set: {
					name: entity.name,
					nameCn: entity.name_cn,
					type: entity.type,
					updatedAt: sql`NOW()`,
				},
			})
			.returning({ id: entities.id });
		const entityId = row?.id;
		if (!entityId) throw new Error(`Failed to sync entity ${canonical}: no entity id returned`);
		entityIds.push(entityId);
		await upsertEntityTranslationRows(db, entityId, entity);
	}

	return { normalizedEntities, entityIds };
}

async function upsertEntityTranslationRows(db: CoreDb, entityId: string, entity: ResourceEntityInput): Promise<void> {
	const labels: Array<{ lang: string; name: string; source: ResourceTranslationSource }> = [
		{ lang: 'en', name: entity.name, source: 'original' },
	];
	if (entity.name_cn.trim()) labels.push({ lang: 'zh-Hant', name: entity.name_cn, source: 'machine' });

	for (const label of labels) {
		await db
			.insert(entityTranslations)
			.values({ entityId, lang: label.lang, name: label.name, source: label.source })
			.onConflictDoUpdate({
				target: [entityTranslations.entityId, entityTranslations.lang],
				set: {
					name: sql`COALESCE(NULLIF(excluded.name, ''), ${entityTranslations.name})`,
					source: sql`CASE WHEN ${entityTranslations.source} = 'original' THEN ${entityTranslations.source} ELSE excluded.source END`,
					updatedAt: sql`NOW()`,
				},
			});
	}
}

async function refreshEntityResourceCounts(db: CoreDb, entityIds: string[]): Promise<void> {
	const uniqueIds = [...new Set(entityIds)];
	if (!uniqueIds.length) return;
	await db.execute(sql`
		UPDATE entities e
		    SET resource_count = counts.resource_count
		   FROM (
		     SELECT ids.id, COUNT(DISTINCT links.resource_id)::int AS resource_count
		       FROM unnest(${uniqueIds}::uuid[]) AS ids(id)
		       LEFT JOIN resource_entities links ON links.entity_id = ids.id
		      GROUP BY ids.id
		   ) counts
		  WHERE e.id = counts.id
	`);
}

type ExistingArticleRecord = {
	id: string;
	url: string;
	source: string;
	resource_type: string;
	summary_cn: string | null;
};

export async function getExistingResourcesByUrl(db: CoreDb, urls: string[]): Promise<ExistingArticleRecord[]> {
	if (urls.length === 0) return [];
	const result = await db.execute(sql`
		SELECT
			r.id::text AS id,
			COALESCE(r.normalized_url, r.url) AS url,
			r.type AS source,
			r.type AS resource_type,
			zh.summary AS summary_cn
		FROM resources r
		LEFT JOIN resource_translations zh
		  ON zh.resource_id = r.id AND zh.lang = 'zh-Hant'
		WHERE r.normalized_url = ANY(${urls}::text[])
		   OR r.url = ANY(${urls}::text[])
	`);
	return result.rows as unknown as ExistingArticleRecord[];
}

export async function reopenResourceForReprocessing(
	db: CoreDb,
	resourceId: string,
	update: { summary: string; content: string; platformMetadata: unknown },
): Promise<void> {
	const [resource] = await db.select({ originalLang: resources.originalLang }).from(resources).where(eq(resources.id, resourceId)).limit(1);
	if (!resource) throw new Error(`Failed to reopen resource ${resourceId}: not found`);
	await db
		.update(resources)
		.set({
			platformMetadata: update.platformMetadata,
			enrichmentStatus: 'pending',
			embedding: null,
			updatedAt: sql`NOW()`,
		})
		.where(eq(resources.id, resourceId));
	await db
		.insert(resourceTranslations)
		.values({
			resourceId,
			lang: resource.originalLang,
			summary: update.summary,
			content: update.content,
			keywords: [],
			source: 'original',
		})
		.onConflictDoUpdate({
			target: [resourceTranslations.resourceId, resourceTranslations.lang],
			set: {
				summary: update.summary,
				content: update.content,
				source: 'original',
				updatedAt: sql`NOW()`,
			},
		});
	await db
		.delete(resourceTranslations)
		.where(and(eq(resourceTranslations.resourceId, resourceId), not(eq(resourceTranslations.lang, resource.originalLang))));
}
