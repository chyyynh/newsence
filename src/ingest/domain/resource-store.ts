import {
	CONTENT_RESOURCE_TYPES,
	type ContentResourceType,
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	DEFAULT_RESOURCE_LANG,
	isContentResourceType,
	RESOURCE_CATEGORIES,
	RESOURCE_ORIGINAL_CONTENT_TYPES,
	RESOURCE_SCOPES,
	RESOURCE_TRANSLATION_SOURCES,
	type ResourceCategory,
	type ResourceScope,
	type ResourceTranslationSource,
} from '@core-shared/resource-types';
import type { ResourceForProcessing, ResourceLocaleText, ResourceTranslationMap } from '@core-shared/types';
import { type CoreDb, withCoreDb, withCoreTx } from '@db/client';
import { resources, resourceTranslations, youtubeTranscripts } from '@db/schema';
import { textArraySql } from '@db/sql';
import { and, eq, not, type SQL, sql } from 'drizzle-orm';
import { upsertResourceTranslation } from './resource-translation-store';
import { buildResourceUpdate, mergePlatformMetadata, type ResourceUpdate } from './resource-update';

type StoredResourceForProcessing = ResourceForProcessing & {
	has_content?: boolean;
	has_youtube_transcript?: boolean;
};

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
	has_youtube_transcript?: boolean;
	storage_key?: string | null;
	file_type?: string;
	normalized_source_url?: string | null;
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
					type: resources.type,
					complete: sql<boolean>`${resources.enrichmentStatus} = 'enriched'
								AND (
									${resources.type} <> 'youtube'
									OR EXISTS (
										SELECT 1
										FROM ${youtubeTranscripts}
										WHERE ${youtubeTranscripts.videoId} = ${resources.platformMetadata}->'data'->>'videoId'
									)
								)
								AND EXISTS (
									SELECT 1
									FROM ${resourceTranslations} original
									WHERE original.resource_id = ${resources.id}
									  AND original.lang = ${resources.originalLang}
									  AND NULLIF(BTRIM(original.title), '') IS NOT NULL
									  AND (
										${resources.scope} <> 'corpus'
										OR ${resources.type} <> ALL(${textArraySql(RESOURCE_ORIGINAL_CONTENT_TYPES)})
										OR ${resources.url} IS NULL
										OR (
											NULLIF(BTRIM(original.content), '') IS NOT NULL
										)
									  )
								)`,
				})
				.from(resources)
				.where(eq(resources.id, resourceId))
				.limit(1)
		)[0];
		if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
		parseResourceType(row.type);
		return row.complete;
	});
}

export async function assertResourceProcessable(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		const row = (await db.select({ type: resources.type }).from(resources).where(eq(resources.id, resourceId)).limit(1))[0];
		if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
		parseResourceType(row.type);
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
			${
				shell
					? sql`CASE
						WHEN rl.type = 'youtube' THEN EXISTS (
							SELECT 1
							FROM ${youtubeTranscripts}
							WHERE ${youtubeTranscripts.videoId} = rl.platform_metadata->'data'->>'videoId'
						)
						ELSE NULL
					END`
					: sql`NULL::boolean`
			} AS has_youtube_transcript,
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
	if (typeof row.has_youtube_transcript === 'boolean') resource.has_youtube_transcript = row.has_youtube_transcript;
	if ('storage_key' in row) resource.storage_key = row.storage_key ?? null;
	if (row.file_type) resource.file_type = row.file_type;
	if ('normalized_source_url' in row) resource.normalized_source_url = row.normalized_source_url ?? null;
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
	type: ContentResourceType;
	originalLang?: string;
	content: string | null;
	platformMetadata: unknown | null;
	previewImageUrl?: string | null;
	keywords?: string[];
	tags?: string[];
}

type ResourceMirrorOrigin = 'source' | 'resource';
type ResourceEnrichmentStatus = 'pending' | 'enriched' | 'failed';

interface ResourceMirrorRecord {
	id: string;
	type: ContentResourceType;
	scope: ResourceScope;
	url: string | null;
	normalizedUrl: string | null;
	storageKey: string | null;
	fileType: string | null;
	originalLang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	publishedDate: Date | null;
	scrapedDate: Date;
	keywords: string[];
	tags: string[];
	category: ResourceCategory | null;
	ogImageUrl: string | null;
	platformMetadataJson: string | null;
	enrichmentStatus: ResourceEnrichmentStatus;
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
	await invalidateChangedMachineTranslationFields(db, resourceId, record);
	const tags = textArraySql(record.tags);
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
		       tags = CASE WHEN cardinality(${tags}) > 0 THEN ${tags} ELSE resources.tags END,
		       category = COALESCE(${record.category}, resources.category),
		       og_image_url = ${record.ogImageUrl},
		       platform_metadata = COALESCE(${record.platformMetadataJson}::jsonb, resources.platform_metadata),
		       enrichment_status = 'enriched',
		       updated_at = now()
		 WHERE id = ${resourceId}::uuid
		 RETURNING id::text AS id
	`);
	const updatedId = (result.rows as Array<{ id?: string }>)[0]?.id;
	if (!updatedId) throw new Error(`Failed to update resource ${resourceId}: no rows matched`);
	await syncOriginalResourceTranslation(db, updatedId, record);
	return updatedId;
}

async function invalidateChangedMachineTranslationFields(db: CoreDb, resourceId: string, record: ResourceMirrorRecord): Promise<void> {
	await db.execute(sql`
		WITH original AS (
			SELECT resource.original_lang, translation.title, translation.summary, translation.content
			FROM resources resource
			JOIN resource_translations translation
			  ON translation.resource_id = resource.id
			 AND translation.lang = resource.original_lang
			WHERE resource.id = ${resourceId}::uuid
			FOR UPDATE OF translation
		)
		UPDATE resource_translations AS machine
		SET title = CASE
				WHEN original.original_lang IS DISTINCT FROM ${record.originalLang}
				  OR original.title IS DISTINCT FROM ${record.title}
				THEN NULL ELSE machine.title
			END,
			summary = CASE
				WHEN original.original_lang IS DISTINCT FROM ${record.originalLang}
				  OR original.summary IS DISTINCT FROM ${record.summary}
				THEN NULL ELSE machine.summary
			END,
			content = CASE
				WHEN original.original_lang IS DISTINCT FROM ${record.originalLang}
				  OR original.content IS DISTINCT FROM ${record.content}
				THEN NULL ELSE machine.content
			END,
			updated_at = NOW()
		FROM original
		WHERE machine.resource_id = ${resourceId}::uuid
		  AND machine.lang <> original.original_lang
		  AND machine.source = 'machine'
		  AND (
			original.original_lang IS DISTINCT FROM ${record.originalLang}
			OR original.title IS DISTINCT FROM ${record.title}
			OR original.summary IS DISTINCT FROM ${record.summary}
			OR original.content IS DISTINCT FROM ${record.content}
		  )
	`);
}

function preparedRecordToResource(base: SourceResourceDraft): ResourceForProcessing {
	return {
		id: base.url,
		original_lang: canonicalizeOptionalResourceLang(base.originalLang) ?? DEFAULT_RESOURCE_LANG,
		title: base.title,
		scope: 'corpus',
		summary: base.summary,
		content: base.content,
		translations: {},
		url: base.url,
		og_image_url: base.previewImageUrl ?? null,
		source: base.source,
		published_date: formatPublishedDate(base.publishedDate),
		tags: base.tags ?? [],
		keywords: base.keywords ?? [],
		type: base.type,
		platform_metadata: (base.platformMetadata ?? undefined) as ResourceForProcessing['platform_metadata'],
	};
}

export async function upsertPendingSourceResource(db: CoreDb, base: SourceResourceDraft): Promise<string> {
	const resource = preparedRecordToResource(base);
	const record = resourceMirrorRecord(
		'source',
		crypto.randomUUID(),
		resource,
		buildResourceUpdate(resource, { previewImageUrl: resource.og_image_url ?? null }),
		'pending',
	);
	const result = await db.execute(resourceUpsertStatement(record));
	const row = (result.rows as Array<{ enrichment_status?: string; id?: string }>)[0];
	const resourceId = row?.id;
	if (!resourceId) throw new Error(`Failed to upsert pending resource for ${base.url}`);
	if (row.enrichment_status !== 'enriched') await syncOriginalResourceTranslation(db, resourceId, record);
	return resourceId;
}

function resourceMirrorRecord(
	origin: ResourceMirrorOrigin,
	resourceId: string,
	resource: ResourceForProcessing,
	updatePayload: ResourceUpdate,
	enrichmentStatus: ResourceEnrichmentStatus = 'enriched',
): ResourceMirrorRecord {
	const storedPlatformMetadata = updatePayload.platform_metadata;
	const fileType = stringOrNull(resource.file_type);
	const url = cleanString(resource.url);
	const normalizedUrl = origin === 'resource' ? cleanString(resource.normalized_source_url ?? resource.url) : url;
	const tags = stringArrayValue(updatePayload.tags, 'tags');
	const keywords = stringArrayValue(updatePayload.keywords, 'keywords');
	const title = cleanString(updatePayload.title);
	const summary = cleanString(updatePayload.summary);
	const content = cleanString(updatePayload.content);
	return {
		id: resourceId,
		type: parseResourceType(updatePayload.type),
		scope: origin === 'source' ? 'corpus' : resource.scope,
		url,
		normalizedUrl,
		storageKey: cleanString(resource.storage_key),
		fileType,
		originalLang: canonicalizeResourceLang(resource.original_lang),
		title,
		summary,
		content,
		publishedDate: optionalDateValue(resource.published_date, 'published_date'),
		scrapedDate: new Date(),
		keywords,
		tags,
		category: deriveResourceCategory(storedPlatformMetadata, tags),
		ogImageUrl: cleanString(updatePayload.og_image_url),
		platformMetadataJson: jsonbParam(storedPlatformMetadata),
		enrichmentStatus,
	};
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
			sql`ON CONFLICT (normalized_url) WHERE normalized_url IS NOT NULL DO UPDATE SET ${resourceConflictSetSql()}
				WHERE resources.scope <> 'private' OR excluded.scope = 'private'`,
		);
	}
	if (record.storageKey) {
		return resourceInsertStatement(record, sql`ON CONFLICT (storage_key) DO UPDATE SET ${resourceConflictSetSql()}`);
	}
	return resourceInsertStatement(record, sql`ON CONFLICT (id) DO UPDATE SET ${resourceConflictSetSql()}`);
}

function resourceInsertStatement(record: ResourceMirrorRecord, conflictSql: SQL): SQL {
	const tags = textArraySql(record.tags);
	return sql`
		INSERT INTO resources (
			id, type, scope, url, normalized_url, storage_key, file_type,
			original_lang, published_date, scraped_date, tags, category,
			og_image_url, platform_metadata, enrichment_status,
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
			${tags},
			${record.category},
			${record.ogImageUrl},
			${record.platformMetadataJson}::jsonb,
			${record.enrichmentStatus},
			now(),
			now()
		)
		${conflictSql}
		RETURNING id::text AS id, enrichment_status
	`;
}

function resourceConflictSetSql(): SQL {
	const preserveEnriched = sql`excluded.enrichment_status = 'pending' AND resources.enrichment_status = 'enriched'`;
	return sql`
		type = CASE WHEN ${preserveEnriched} THEN resources.type ELSE excluded.type END,
		scope = CASE
			WHEN resources.scope = 'corpus' OR excluded.scope = 'private' THEN resources.scope
			ELSE excluded.scope
		END,
		url = CASE WHEN ${preserveEnriched} THEN resources.url ELSE COALESCE(excluded.url, resources.url) END,
		storage_key = CASE WHEN ${preserveEnriched} THEN resources.storage_key ELSE COALESCE(excluded.storage_key, resources.storage_key) END,
		file_type = CASE WHEN ${preserveEnriched} THEN resources.file_type ELSE COALESCE(excluded.file_type, resources.file_type) END,
		original_lang = CASE WHEN ${preserveEnriched} THEN resources.original_lang ELSE excluded.original_lang END,
		published_date = CASE
			WHEN ${preserveEnriched} THEN resources.published_date
			ELSE COALESCE(excluded.published_date, resources.published_date)
		END,
		scraped_date = CASE
			WHEN ${preserveEnriched} THEN resources.scraped_date
			ELSE COALESCE(excluded.scraped_date, resources.scraped_date)
		END,
		tags = CASE
			WHEN ${preserveEnriched} THEN resources.tags
			WHEN cardinality(excluded.tags) > 0 THEN excluded.tags
			ELSE resources.tags
		END,
		category = CASE WHEN ${preserveEnriched} THEN resources.category ELSE COALESCE(excluded.category, resources.category) END,
		og_image_url = CASE
			WHEN ${preserveEnriched} THEN resources.og_image_url
			ELSE excluded.og_image_url
		END,
		platform_metadata = CASE
			WHEN ${preserveEnriched} THEN resources.platform_metadata
			ELSE COALESCE(excluded.platform_metadata, resources.platform_metadata)
		END,
		enrichment_status = CASE
			WHEN ${preserveEnriched} THEN resources.enrichment_status
			ELSE excluded.enrichment_status
		END,
		updated_at = CASE WHEN ${preserveEnriched} THEN resources.updated_at ELSE now() END
	`;
}

async function syncOriginalResourceTranslation(db: CoreDb, resourceId: string, record: ResourceMirrorRecord): Promise<void> {
	if (
		!(await upsertResourceTranslation(db, {
			resourceId,
			lang: record.originalLang,
			title: record.title,
			summary: record.summary,
			content: record.content,
			keywords: record.keywords,
			source: 'original',
		}))
	) {
		throw new Error(`Failed to sync original translation for resource ${resourceId}`);
	}
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

function parseResourceType(value: unknown): ContentResourceType {
	if (!isContentResourceType(value)) throw new Error(`Resource type is not processable by core: ${String(value)}`);
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

type ExistingResourceRecord = {
	id: string;
	url: string;
	type: ContentResourceType;
	shouldRetryEnrichment: boolean;
};

export async function getExistingResourcesByUrl(db: CoreDb, urls: string[]): Promise<ExistingResourceRecord[]> {
	if (urls.length === 0) return [];
	const urlArray = sql`ARRAY[${sql.join(
		urls.map((url) => sql`${url}`),
		sql`, `,
	)}]::text[]`;
	const result = await db.execute(sql`
		SELECT
			r.id::text AS id,
			COALESCE(r.normalized_url, r.url) AS url,
			r.type AS type,
			(
				r.enrichment_status = 'pending'
				OR (r.enrichment_status = 'failed' AND r.updated_at < NOW() - INTERVAL '30 minutes')
			) AS "shouldRetryEnrichment"
		FROM resources r
			WHERE (r.normalized_url = ANY(${urlArray}) OR r.url = ANY(${urlArray}))
			  AND r.type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
	`);
	return result.rows as unknown as ExistingResourceRecord[];
}

export async function reopenResourceForReprocessing(
	env: CoreEnv,
	resourceId: string,
	update: { summary: string; content: string; platformMetadata: unknown },
): Promise<boolean> {
	return withCoreTx(env, async (db) => {
		const resourceResult = await db.execute(sql`
			SELECT original_lang, platform_metadata
			FROM resources
			WHERE id = ${resourceId}::uuid
			FOR UPDATE
		`);
		const resource = (resourceResult.rows as Array<{ original_lang: string; platform_metadata: unknown }>)[0];
		if (!resource) throw new Error(`Failed to reopen resource ${resourceId}: not found`);

		const translationResult = await db.execute(sql`
			SELECT summary, content, source
			FROM resource_translations
			WHERE resource_id = ${resourceId}::uuid
			  AND lang = ${resource.original_lang}
			FOR UPDATE
		`);
		const original = (
			translationResult.rows as Array<{
				summary: string | null;
				content: string | null;
				source: ResourceTranslationSource;
			}>
		)[0];
		if (!original) throw new Error(`Failed to reopen resource ${resourceId}: original translation not found`);

		const preserveOwnedTranslation = original.source === 'human';
		const effectiveSummary = preserveOwnedTranslation || update.summary === '' ? original.summary : update.summary;
		const effectiveContent = preserveOwnedTranslation || update.content === '' ? original.content : update.content;
		const sourceContentChanged = original.content !== effectiveContent;
		if (original.summary === effectiveSummary && !sourceContentChanged) return false;

		await db
			.update(resources)
			.set({
				platformMetadata: mergePlatformMetadata(resource.platform_metadata, update.platformMetadata),
				enrichmentStatus: 'pending',
				updatedAt: sql`NOW()`,
			})
			.where(eq(resources.id, resourceId));
		if (
			!(await upsertResourceTranslation(db, {
				resourceId,
				lang: resource.original_lang,
				summary: update.summary,
				content: update.content,
				keywords: [],
				source: 'original',
			}))
		) {
			throw new Error(`Failed to reopen original translation for resource ${resourceId}`);
		}
		if (sourceContentChanged) {
			await db
				.delete(resourceTranslations)
				.where(
					and(
						eq(resourceTranslations.resourceId, resourceId),
						not(eq(resourceTranslations.lang, resource.original_lang)),
						not(eq(resourceTranslations.source, 'human')),
					),
				);
		}
		return true;
	});
}
