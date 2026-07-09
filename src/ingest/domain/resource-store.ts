import type { ResourceForProcessing, ResourceLocaleText, ResourceTranslationMap } from '@core-shared/types';
import { type CoreDb, withCoreDb } from '@db/client';
import { entities, entityTranslations, resourceEntities, resources, resourceTranslations } from '@db/schema';
import { canonicalizeEntityName, normalizeResourceEntitiesForStorage, type ResourceEntityInput } from '@entities/normalize';
import { and, eq, inArray, not, type SQL, sql } from 'drizzle-orm';
import {
	canonicalizeResourceLang,
	DEFAULT_RESOURCE_LANG,
	isResourceType,
	RESOURCE_CATEGORIES,
	RESOURCE_SCOPES,
	RESOURCE_TRANSLATION_SOURCES,
	type ResourceCategory,
	type ResourceScope,
	type ResourceTranslationSource,
	type ResourceType,
	ZH_HANT_RESOURCE_LANG,
} from '../../resources/types';
import type { ResourceUpdate } from './resource-update';

type StoredResourceForProcessing = ResourceForProcessing & { has_content?: boolean };

interface ResourceStoreRow {
	id: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	original_lang: string;
	translations: unknown;
	url: string | null;
	og_image_url: string | null;
	source: string | null;
	type: string | null;
	scope: string | null;
	published_date: Date | string | null;
	tags: string[];
	keywords: string[];
	platform_metadata: unknown;
	enrichment_status?: string;
	has_content?: boolean;
	storage_key?: string | null;
	file_type?: string;
	normalized_source_url?: string | null;
	origin_type?: string;
}

type ResourceStoreTranslationRow = {
	lang?: unknown;
	title?: unknown;
	summary?: unknown;
	content?: unknown;
	keywords?: unknown;
	source?: unknown;
};

export async function loadResourceForProcessing(env: CoreEnv, resourceId: string, shell = false): Promise<StoredResourceForProcessing> {
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

async function loadStoredResourceRow(db: CoreDb, resourceId: string, shell: boolean): Promise<StoredResourceForProcessing | undefined> {
	const result = await db.execute(sql`
		SELECT
			rl.id::text AS id,
			rl.title AS title,
			rl.summary AS summary,
			${shell ? sql`NULL::text` : sql`rl.content`} AS content,
			${shell ? sql`rl.content IS NOT NULL AND length(rl.content) > 0` : sql`NULL::boolean`} AS has_content,
			rl.original_lang AS original_lang,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'lang', rt.lang,
							'title', rt.title,
							'summary', rt.summary,
							'content', ${shell ? sql`NULL::text` : sql`rt.content`},
							'keywords', COALESCE(rt.keywords, '{}'::text[]),
							'source', rt.source
						)
						ORDER BY (rt.lang = rl.original_lang) DESC, rt.lang ASC
					)
					FROM resource_translations rt
					WHERE rt.resource_id = rl.id
				),
				'[]'::jsonb
			) AS translations,
			rl.url AS url,
			rl.og_image_url AS og_image_url,
			COALESCE(NULLIF(rl.platform_metadata->>'sourceName', ''), rl.type) AS source,
			rl.type AS type,
			rl.scope AS scope,
			rl.published_date AS published_date,
			rl.tags AS tags,
			COALESCE(rl.keywords, '{}'::text[]) AS keywords,
			rl.platform_metadata AS platform_metadata,
			rl.enrichment_status AS enrichment_status,
			rl.storage_key AS storage_key,
			rl.file_type AS file_type,
			rl.normalized_url AS normalized_source_url
		FROM resources_localized rl
		WHERE rl.id = ${resourceId}::uuid
		  AND rl.lang = rl.original_lang
		LIMIT 1
	`);
	const row = (result.rows as unknown as ResourceStoreRow[])[0];
	return row ? resourceStoreRowToProcessing(row) : undefined;
}

function resourceStoreRowToProcessing(row: ResourceStoreRow): StoredResourceForProcessing {
	const resource: StoredResourceForProcessing = {
		id: row.id,
		original_lang: canonicalizeResourceLang(row.original_lang),
		title: row.title ?? '',
		summary: row.summary,
		content: row.content,
		translations: resourceStoreTranslations(row),
		url: row.url ?? '',
		og_image_url: row.og_image_url,
		source: row.source ?? '',
		published_date: formatPublishedDate(row.published_date),
		tags: row.tags,
		keywords: row.keywords,
		type: parseResourceType(row.type),
		scope: parseResourceScope(row.scope),
		platform_metadata: (row.platform_metadata ?? undefined) as ResourceForProcessing['platform_metadata'],
	};
	if (typeof row.has_content === 'boolean') resource.has_content = row.has_content;
	if ('storage_key' in row) resource.storage_key = row.storage_key ?? null;
	if (row.file_type) resource.file_type = row.file_type;
	if ('normalized_source_url' in row) resource.normalized_source_url = row.normalized_source_url ?? null;
	if (row.origin_type) resource.origin_type = row.origin_type;
	return resource;
}

function resourceStoreTranslations(row: ResourceStoreRow): ResourceTranslationMap {
	const map: ResourceTranslationMap = {};
	if (!Array.isArray(row.translations)) return map;
	for (const item of row.translations) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
		const translation = item as ResourceStoreTranslationRow;
		const lang = canonicalizeResourceLang(translation.lang);
		const compact = compactLocaleText({
			title: translation.title as ResourceLocaleText['title'],
			summary: translation.summary as ResourceLocaleText['summary'],
			content: translation.content as ResourceLocaleText['content'],
			keywords:
				translation.keywords === null || translation.keywords === undefined
					? null
					: stringArrayValue(translation.keywords, 'translation keywords'),
			source: translation.source as ResourceLocaleText['source'],
		});
		if (compact) map[lang] = compact;
	}
	return map;
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
	type: ResourceType;
	originalLang?: string;
	content: string | null;
	platformMetadata: unknown | null;
	keywords?: string[];
	tags?: string[];
}

type ResourceMirrorOrigin = 'source' | 'resource';
type ResourceEnrichmentStatus = 'pending' | 'enriched' | 'failed';

interface ResourceMirrorRecord {
	id: string;
	type: ResourceType;
	scope: ResourceScope;
	url: string | null;
	normalizedUrl: string | null;
	storageKey: string | null;
	fileType: string | null;
	originalLang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	translations: ResourceTranslationMap;
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
	resource: ResourceForProcessing,
	updatePayload: ResourceUpdate,
): Promise<string> {
	const record = resourceMirrorRecord('resource', resourceId, resource, updatePayload);
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

function preparedRecordToResource(base: SourceResourceDraft): ResourceForProcessing {
	return {
		id: base.url,
		original_lang: canonicalizeResourceLang(base.originalLang ?? DEFAULT_RESOURCE_LANG),
		title: base.title,
		scope: 'corpus',
		summary: base.summary,
		content: base.content,
		translations: {},
		url: base.url,
		og_image_url: null,
		source: base.source,
		published_date: formatPublishedDate(base.publishedDate),
		tags: base.tags ?? [],
		keywords: base.keywords ?? [],
		type: base.type,
		platform_metadata: (base.platformMetadata ?? undefined) as ResourceForProcessing['platform_metadata'],
	};
}

export async function upsertPendingSourceResource(db: CoreDb, base: SourceResourceDraft): Promise<string> {
	const record = resourceMirrorRecord('source', crypto.randomUUID(), preparedRecordToResource(base), {}, 'pending');
	const result = await db.execute(resourceUpsertStatement(record));
	const resourceId = (result.rows as Array<{ id?: string }>)[0]?.id;
	if (!resourceId) throw new Error(`Failed to upsert pending resource for ${base.url}`);
	await syncResourceTranslations(db, resourceId, record);
	return resourceId;
}

function resourceMirrorRecord(
	origin: ResourceMirrorOrigin,
	resourceId: string,
	resource: ResourceForProcessing,
	updatePayload: ResourceUpdate,
	enrichmentStatus: ResourceEnrichmentStatus = 'enriched',
): ResourceMirrorRecord {
	const platformMetadata = updatePayload.platform_metadata ?? resource.platform_metadata ?? null;
	const storedPlatformMetadata = platformMetadataWithSourceName(platformMetadata, resource.source);
	const fileType = stringOrNull(resource.file_type);
	const url = cleanString(resource.url);
	const normalizedUrl = origin === 'resource' ? cleanString(resource.normalized_source_url ?? resource.url) : url;
	const tags = stringArrayValue(updatePayload.tags ?? resource.tags ?? [], 'tags');
	const keywords = stringArrayValue(updatePayload.keywords ?? resource.keywords ?? [], 'keywords');
	const title = cleanString(resource.title);
	const summary = cleanString(updatePayload.summary ?? resource.summary);
	const content = cleanString(updatePayload.content ?? resource.content);
	const translations = mergeResourceTranslations(resource.translations, updatePayload.translations);
	return {
		id: resourceId,
		type: parseResourceType(updatePayload.type ?? resource.type),
		scope: origin === 'source' ? 'corpus' : resource.scope,
		url,
		normalizedUrl,
		storageKey: cleanString(resource.storage_key),
		fileType,
		originalLang: canonicalizeResourceLang(resource.original_lang),
		title,
		summary,
		content,
		translations,
		publishedDate: optionalDateValue(resource.published_date, 'published_date'),
		scrapedDate: new Date(),
		keywords,
		tags,
		category: deriveResourceCategory(storedPlatformMetadata, tags),
		entitiesJson: jsonbParam(updatePayload.entities ?? null),
		ogImageUrl: cleanString(updatePayload.og_image_url ?? resource.og_image_url),
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

function mergeResourceTranslations(current: ResourceTranslationMap | undefined, update: unknown): ResourceTranslationMap {
	const merged: ResourceTranslationMap = { ...(current ?? {}) };
	if (update === null || update === undefined) return merged;
	if (typeof update !== 'object' || Array.isArray(update)) throw new Error('Invalid translations: expected object');
	for (const [rawLang, value] of Object.entries(update)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		const patch = compactLocaleText(value as ResourceLocaleText);
		if (!patch) continue;
		const lang = canonicalizeResourceLang(rawLang);
		merged[lang] = {
			...(merged[lang] ?? {}),
			...patch,
		};
	}
	return merged;
}

function compactLocaleText(value: ResourceLocaleText): ResourceLocaleText | null {
	const title = cleanString(value.title);
	const summary = cleanString(value.summary);
	const content = cleanString(value.content);
	const keywords =
		value.keywords === null || value.keywords === undefined ? null : stringArrayValue(value.keywords, 'translation keywords');
	const source = parseTranslationSource(value.source);
	if (!title && !summary && !content && !keywords?.length) return null;
	return {
		...(title ? { title } : {}),
		...(summary ? { summary } : {}),
		...(content ? { content } : {}),
		...(keywords?.length ? { keywords } : {}),
		...(source ? { source } : {}),
	};
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
	const originalTranslation = record.translations[record.originalLang];
	const translations: ResourceTranslationRecord[] = [
		{
			resourceId,
			lang: record.originalLang,
			title: record.title,
			summary: record.summary,
			content: record.content,
			keywords: originalTranslation?.keywords?.length ? originalTranslation.keywords : record.keywords,
			source: 'original',
		},
	];

	for (const [rawLang, translation] of Object.entries(record.translations)) {
		const lang = canonicalizeResourceLang(rawLang);
		if (lang === record.originalLang) continue;
		const compact = translation ? compactLocaleText(translation) : null;
		if (!compact) continue;
		translations.push({
			resourceId,
			lang,
			title: cleanString(compact.title),
			summary: cleanString(compact.summary),
			content: cleanString(compact.content),
			keywords: compact.keywords?.length ? compact.keywords : record.keywords,
			source: parseTranslationSource(compact.source) ?? 'machine',
		});
	}

	return translations;
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

function deriveResourceCategory(platformMetadata: unknown, tags: string[]): ResourceCategory | null {
	if (platformMetadata && typeof platformMetadata === 'object' && !Array.isArray(platformMetadata)) {
		const category = (platformMetadata as { classification?: { category?: unknown } }).classification?.category;
		if (isResourceCategory(category)) return category;
	}
	return tags.find(isResourceCategory) ?? null;
}

function parseResourceType(value: unknown): ResourceType {
	if (!isResourceType(value)) throw new Error(`Invalid resource type: ${String(value)}`);
	return value;
}

function isResourceScope(value: unknown): value is ResourceScope {
	return typeof value === 'string' && (RESOURCE_SCOPES as readonly string[]).includes(value);
}

function parseResourceScope(value: unknown): ResourceScope {
	if (!isResourceScope(value)) throw new Error(`Invalid resource scope: ${String(value)}`);
	return value;
}

function isTranslationSource(value: unknown): value is ResourceTranslationSource {
	return typeof value === 'string' && (RESOURCE_TRANSLATION_SOURCES as readonly string[]).includes(value);
}

function parseTranslationSource(value: unknown): ResourceTranslationSource | null {
	if (value === null || value === undefined) return null;
	if (!isTranslationSource(value)) throw new Error(`Invalid translation source: ${String(value)}`);
	return value;
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

type ExistingResourceRecord = {
	id: string;
	url: string;
	type: ResourceType;
	hasZhHantSummary: boolean;
};

export async function getExistingResourcesByUrl(db: CoreDb, urls: string[]): Promise<ExistingResourceRecord[]> {
	if (urls.length === 0) return [];
	const result = await db.execute(sql`
		SELECT
			r.id::text AS id,
			COALESCE(r.normalized_url, r.url) AS url,
			r.type AS type,
			EXISTS (
				SELECT 1
				  FROM resource_translations rt
				 WHERE rt.resource_id = r.id
				   AND rt.lang = ${ZH_HANT_RESOURCE_LANG}
				   AND NULLIF(rt.summary, '') IS NOT NULL
			) AS "hasZhHantSummary"
		FROM resources r
		WHERE r.normalized_url = ANY(${urls}::text[])
		   OR r.url = ANY(${urls}::text[])
	`);
	return result.rows as unknown as ExistingResourceRecord[];
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
