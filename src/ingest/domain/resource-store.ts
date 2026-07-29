import {
	type ContentResourceType,
	canonicalizeOptionalResourceLang,
	canonicalizeResourceLang,
	DEFAULT_RESOURCE_LANG,
	hasSemanticScholarAcademicEnrichment,
	isContentResourceKind,
	isContentResourceType,
	isResourceType,
	legacyResourceIdentity,
	parseResourceIdentity,
	RESOURCE_CATEGORIES,
	RESOURCE_SCOPES,
	RESOURCE_TRANSLATION_SOURCES,
	type ResourceCategory,
	type ResourceKind,
	type ResourcePlatform,
	type ResourceScope,
	type ResourceTranslationSource,
	resourceIdentityForDetectedPlatform,
	type SourceAcquisitionMode,
} from '@core-shared/resource-types';
import type {
	PlatformMetadata,
	ResourceForProcessing,
	ResourceLocaleText,
	ResourceTranslationMap,
	StoredResourceEntity,
} from '@core-shared/types';
import { detectResourcePlatform } from '@core-shared/url';
import { type CoreDb, textArraySql, uuidArraySql, withCoreDb, withCoreTx } from '@db/client';
import { contentResourceIdentitySql, resourceDisplaySourceSql, translatableResourceIdentitySql } from '@db/resource-identity-sql';
import { assertResourceWritesEnabled, assertResourceWritesEnabledInDb } from '@db/resource-write-guard';
import { resources, resourceTranslations, youtubeTranscripts } from '@db/schema';
import { and, eq, not, type SQL, sql } from 'drizzle-orm';

/** Failed enrichments to retry before a URL is treated as permanently dead. */
export const MAX_ENRICHMENT_ATTEMPTS = 5;

type StoredResourceForProcessing = ResourceForProcessing & {
	has_content?: boolean;
	has_youtube_transcript?: boolean;
};

type ResourceUpdate = Pick<ResourceForProcessing, 'summary' | 'content' | 'tags' | 'keywords'> & {
	og_image_url: string | null;
	platform_metadata: PlatformMetadata | null;
};

type ProcessedResourceUpdate = ResourceUpdate & {
	entities: StoredResourceEntity[];
};

type ResourceStoreRow = {
	id: string;
	source_id: string | null;
	source_acquisition_mode: string | null;
	kind: string | null;
	resource_platform: string | null;
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
	enrichment_status: string;
	published_date: Date | string | null;
	scraped_date: Date | string | null;
	updated_at: Date | string;
	created_at: Date | string;
	tags: string[];
	keywords: string[];
	platform_metadata: unknown;
	has_content?: boolean;
	has_youtube_transcript?: boolean;
	storage_key?: string | null;
	file_type?: string | null;
	normalized_url?: string | null;
};

type ResourceStoreTranslationRow = {
	lang?: unknown;
	title?: unknown;
	summary?: unknown;
	content?: unknown;
	keywords?: unknown;
	source?: unknown;
};

type StoredResourceIdentityRow = {
	kind: string | null;
	resource_platform: string | null;
	type: string | null;
	url: string | null;
	enrichment_status: string;
	platform_metadata: unknown;
};

function storedResourceIdentity(row: StoredResourceIdentityRow) {
	const stored = parseResourceIdentity(row.kind, row.resource_platform);
	if (stored) return stored;
	if (row.kind !== null || row.resource_platform !== null) {
		throw new Error(`Invalid stored resource identity: ${String(row.kind)} / ${String(row.resource_platform)}`);
	}
	if (!isResourceType(row.type)) throw new Error(`Invalid legacy resource type: ${String(row.type)}`);

	const hasAcademicEnrichment = hasSemanticScholarAcademicEnrichment(row.platform_metadata);
	const detectedPlatform = detectResourcePlatform(row.url);
	if (row.enrichment_status !== 'enriched') {
		if (detectedPlatform) return resourceIdentityForDetectedPlatform(detectedPlatform, hasAcademicEnrichment);
		if (row.type === 'twitter' || row.type === 'youtube' || row.type === 'hackernews') {
			throw new Error(`Cannot verify pending ${row.type} resource platform from URL: ${String(row.url)}`);
		}
	}
	return legacyResourceIdentity(row.type, hasAcademicEnrichment);
}

function parseSourceAcquisitionMode(value: unknown): SourceAcquisitionMode | null {
	if (value === null || value === undefined) return null;
	if (value === 'platform' || value === 'web' || value === 'feed') return value;
	throw new Error(`Invalid source acquisition mode: ${String(value)}`);
}

export function resourceTranslationIdentityPredicate(): SQL {
	return translatableResourceIdentitySql({
		fileType: sql`${resources.fileType}`,
		kind: sql`${resources.kind}`,
		resourcePlatform: sql`${resources.resourcePlatform}`,
		type: sql`${resources.type}`,
	});
}

function effectiveResourcePlatformPredicate(platform: Exclude<ResourcePlatform, null>): SQL {
	return sql`((
		CASE
			WHEN ${resources.kind} IS NOT NULL THEN ${resources.resourcePlatform}
			WHEN ${resources.type} = ${platform} THEN ${platform}
			ELSE NULL
		END
	) = ${platform}) IS TRUE`;
}

export async function loadResourceForProcessing(env: CoreEnv, resourceId: string): Promise<StoredResourceForProcessing> {
	return loadResource(env, resourceId, false);
}

export async function loadResourceShellForProcessing(env: CoreEnv, resourceId: string): Promise<StoredResourceForProcessing> {
	return loadResource(env, resourceId, true);
}

async function loadResource(env: CoreEnv, resourceId: string, shell: boolean): Promise<StoredResourceForProcessing> {
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
					kind: resources.kind,
					resourcePlatform: resources.resourcePlatform,
					type: resources.type,
					url: resources.url,
					enrichmentStatus: resources.enrichmentStatus,
					platformMetadata: resources.platformMetadata,
					complete: sql<boolean>`${resources.enrichmentStatus} = 'enriched'
								AND (
									NOT (${effectiveResourcePlatformPredicate('youtube')})
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
										OR NOT (${resourceTranslationIdentityPredicate()})
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
		const identity = storedResourceIdentity({
			kind: row.kind,
			resource_platform: row.resourcePlatform,
			type: row.type,
			url: row.url,
			enrichment_status: row.enrichmentStatus,
			platform_metadata: row.platformMetadata,
		});
		if (!isContentResourceKind(identity.kind)) {
			throw new Error(`Resource kind is not processable by core: ${identity.kind}`);
		}
		return row.complete;
	});
}

export async function assertResourceProcessable(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		const row = (
			await db
				.select({
					kind: resources.kind,
					resourcePlatform: resources.resourcePlatform,
					type: resources.type,
					url: resources.url,
					enrichmentStatus: resources.enrichmentStatus,
					platformMetadata: resources.platformMetadata,
				})
				.from(resources)
				.where(eq(resources.id, resourceId))
				.limit(1)
		)[0];
		if (!row) throw new Error(`Failed to fetch resource ${resourceId}: not found`);
		const identity = storedResourceIdentity({
			kind: row.kind,
			resource_platform: row.resourcePlatform,
			type: row.type,
			url: row.url,
			enrichment_status: row.enrichmentStatus,
			platform_metadata: row.platformMetadata,
		});
		if (!isContentResourceKind(identity.kind)) {
			throw new Error(`Resource kind is not processable by core: ${identity.kind}`);
		}
	});
}

async function loadStoredResourceRow(db: CoreDb, resourceId: string, shell: boolean): Promise<StoredResourceForProcessing | undefined> {
	const result = await db.execute<ResourceStoreRow>(sql`
		SELECT
			rl.id::text AS id,
			rl.source_id::text AS source_id,
			monitored_source.content_mode AS source_acquisition_mode,
			rl.kind AS kind,
			rl.resource_platform AS resource_platform,
			rl.title AS title,
			rl.summary AS summary,
			${shell ? sql`NULL::text` : sql`rl.content`} AS content,
			${shell ? sql`rl.content IS NOT NULL AND length(rl.content) > 0` : sql`NULL::boolean`} AS has_content,
			${
				shell
					? sql`CASE
						WHEN (
							CASE
								WHEN rl.kind IS NOT NULL THEN rl.resource_platform
								WHEN rl.type = 'youtube' THEN 'youtube'
								ELSE NULL
							END
						) = 'youtube' THEN EXISTS (
							SELECT 1
							FROM ${youtubeTranscripts}
							WHERE ${youtubeTranscripts.videoId} = rl.platform_metadata->'data'->>'videoId'
						)
						ELSE NULL
					END`
					: sql`NULL::boolean`
			} AS has_youtube_transcript,
			rl.original_lang AS original_lang,
			(
				SELECT jsonb_agg(
					jsonb_build_object(
						'lang', rt.lang,
						'title', rt.title,
						'summary', rt.summary,
						'content', ${shell ? sql`NULL::text` : sql`rt.content`},
						'keywords', rt.keywords,
						'source', rt.source
					)
					ORDER BY (rt.lang = rl.original_lang) DESC, rt.lang ASC
				)
				FROM resource_translations rt
				WHERE rt.resource_id = rl.id
			) AS translations,
			rl.url AS url,
			rl.og_image_url AS og_image_url,
			${resourceDisplaySourceSql({
				kind: sql`rl.kind`,
				monitoredSourceName: sql`monitored_source.name`,
				platformMetadata: sql`rl.platform_metadata`,
				resourcePlatform: sql`rl.resource_platform`,
				type: sql`rl.type`,
			})} AS source,
			rl.type AS type,
			rl.scope AS scope,
			rl.enrichment_status AS enrichment_status,
			rl.published_date AS published_date,
			rl.scraped_date AS scraped_date,
			rl.updated_at AS updated_at,
			rl.created_at AS created_at,
			rl.tags AS tags,
			rl.keywords AS keywords,
			rl.platform_metadata AS platform_metadata,
			rl.storage_key AS storage_key,
			rl.file_type AS file_type,
			rl.normalized_url AS normalized_url
		FROM resources_localized rl
		LEFT JOIN sources monitored_source ON monitored_source.id = rl.source_id
		WHERE rl.id = ${resourceId}::uuid
		  AND rl.lang = rl.original_lang
		LIMIT 1
	`);
	const row = result.rows[0];
	return row ? resourceStoreRowToProcessing(row) : undefined;
}

function resourceStoreRowToProcessing(row: ResourceStoreRow): StoredResourceForProcessing {
	const identity = storedResourceIdentity(row);
	const resource: StoredResourceForProcessing = {
		id: row.id,
		source_id: row.source_id,
		source_acquisition_mode: parseSourceAcquisitionMode(row.source_acquisition_mode),
		kind: identity.kind,
		resource_platform: identity.resourcePlatform,
		original_lang: canonicalizeResourceLang(row.original_lang),
		title: requiredString(row.title, 'title'),
		summary: row.summary,
		content: row.content,
		translations: resourceStoreTranslations(row),
		url: row.url,
		og_image_url: row.og_image_url,
		source: cleanString(row.source),
		published_date: row.published_date === null ? null : dateValue(row.published_date, 'published_date').toISOString(),
		tags: row.tags,
		keywords: row.keywords,
		type: parseResourceType(row.type),
		scope: parseResourceScope(row.scope),
		platform_metadata:
			row.platform_metadata === null || row.platform_metadata === undefined
				? undefined
				: storedPlatformMetadataValue(
						row.platform_metadata,
						dateValue(row.scraped_date ?? row.updated_at ?? row.created_at, 'platform_metadata fallback date').toISOString(),
						row.id,
					),
	};
	if (typeof row.has_content === 'boolean') resource.has_content = row.has_content;
	if (typeof row.has_youtube_transcript === 'boolean') resource.has_youtube_transcript = row.has_youtube_transcript;
	resource.storage_key = row.storage_key ?? null;
	if (row.file_type) resource.file_type = row.file_type;
	resource.normalized_url = row.normalized_url ?? null;
	return resource;
}

function resourceStoreTranslations(row: ResourceStoreRow): ResourceTranslationMap {
	const map: ResourceTranslationMap = {};
	if (!Array.isArray(row.translations)) throw new Error(`Invalid translations for resource ${row.id}: expected array`);
	for (const item of row.translations) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new Error(`Invalid translation for resource ${row.id}: expected object`);
		}
		const translation = item as ResourceStoreTranslationRow;
		const lang = canonicalizeResourceLang(translation.lang);
		const compact = compactLocaleText({
			title: translation.title as ResourceLocaleText['title'],
			summary: translation.summary as ResourceLocaleText['summary'],
			content: translation.content as ResourceLocaleText['content'],
			keywords: stringArrayValue(translation.keywords, 'translation keywords'),
			source: translation.source as ResourceLocaleText['source'],
		});
		if (compact) map[lang] = compact;
	}
	return map;
}

interface SourceResourceDraft {
	sourceId: string;
	url: string;
	title: string;
	source: string;
	publishedDate: Date | string;
	summary: string | null;
	type: ContentResourceType;
	originalLang?: string;
	content: string | null;
	platformMetadata: PlatformMetadata | null;
	previewImageUrl?: string | null;
	keywords?: string[];
	tags?: string[];
}

type ResourceEnrichmentStatus = 'pending' | 'enriched' | 'failed';

interface ResourceMirrorRecord {
	id: string;
	sourceId: string | null;
	kind: ResourceKind;
	resourcePlatform: ResourcePlatform;
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
	updatePayload: ProcessedResourceUpdate,
): Promise<string> {
	await assertResourceWritesEnabledInDb(db, 'update processed resource');
	const record = resourceMirrorRecord(resourceId, resource, updatePayload);
	await invalidateChangedMachineTranslationFields(db, resourceId, record);
	const tags = textArraySql(record.tags);
	const entitiesJson = JSON.stringify(updatePayload.entities);
	const result = await db.execute<{ id: string }>(sql`
		UPDATE resources
		   SET source_id = COALESCE(source_id, ${record.sourceId}::uuid),
		       type = ${record.type},
		       kind = ${record.kind},
		       resource_platform = ${record.resourcePlatform},
		       url = ${record.url},
		       normalized_url = ${record.normalizedUrl},
		       storage_key = ${record.storageKey},
		       file_type = ${record.fileType},
		       original_lang = ${record.originalLang},
		       published_date = ${record.publishedDate},
		       scraped_date = ${record.scrapedDate},
		       tags = ${tags},
		       category = ${record.category},
		       og_image_url = ${record.ogImageUrl},
		       platform_metadata = ${record.platformMetadataJson}::jsonb,
		       entities = ${entitiesJson}::jsonb,
		       enrichment_status = 'enriched',
		       -- Landing enrichment clears the failure streak, so a row that failed
		       -- twice and then succeeded does not carry those attempts forever.
		       enrichment_attempts = 0,
		       updated_at = now()
		 WHERE id = ${resourceId}::uuid
		 RETURNING id::text AS id
	`);
	const updatedId = result.rows[0]?.id;
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
	const detectedPlatform = detectResourcePlatform(base.url);
	const hasAcademicEnrichment = hasSemanticScholarAcademicEnrichment(base.platformMetadata);
	const identity = detectedPlatform
		? resourceIdentityForDetectedPlatform(detectedPlatform, hasAcademicEnrichment)
		: legacyResourceIdentity(base.type, hasAcademicEnrichment);
	return {
		id: base.url,
		source_id: base.sourceId,
		kind: identity.kind,
		resource_platform: identity.resourcePlatform,
		original_lang: canonicalizeOptionalResourceLang(base.originalLang) ?? DEFAULT_RESOURCE_LANG,
		title: base.title,
		scope: 'corpus',
		summary: base.summary,
		content: base.content,
		translations: {},
		url: base.url,
		normalized_url: base.url,
		og_image_url: base.previewImageUrl ?? null,
		source: base.source,
		published_date: dateValue(base.publishedDate, 'published_date').toISOString(),
		tags: base.tags ?? [],
		keywords: base.keywords ?? [],
		type: base.type,
		platform_metadata: (base.platformMetadata ?? undefined) as ResourceForProcessing['platform_metadata'],
	};
}

export async function upsertPendingSourceResource(db: CoreDb, base: SourceResourceDraft): Promise<string> {
	await assertResourceWritesEnabledInDb(db, 'upsert pending source resource');
	const resource = preparedRecordToResource(base);
	const record = resourceMirrorRecord(crypto.randomUUID(), resource, pendingResourceUpdate(resource, base.platformMetadata), 'pending');
	const result = await db.execute<{ enrichment_status: string; id: string }>(resourceUpsertStatement(record));
	const row = result.rows[0];
	const resourceId = row?.id;
	if (!resourceId) throw new Error(`Failed to upsert pending resource for ${base.url}`);
	if (row.enrichment_status !== 'enriched') await syncOriginalResourceTranslation(db, resourceId, record);
	return resourceId;
}

function pendingResourceUpdate(resource: ResourceForProcessing, platformMetadata: PlatformMetadata | null): ResourceUpdate {
	const sourceName = requiredString(resource.source, 'source');
	return {
		summary: resource.summary,
		content: resource.content,
		tags: resource.tags,
		keywords: resource.keywords,
		og_image_url: resource.og_image_url?.trim() || null,
		platform_metadata: platformMetadata ? { ...platformMetadata, sourceName } : null,
	};
}

function resourceMirrorRecord(
	resourceId: string,
	resource: ResourceForProcessing,
	updatePayload: ResourceUpdate,
	enrichmentStatus: ResourceEnrichmentStatus = 'enriched',
): ResourceMirrorRecord {
	const storedPlatformMetadata = updatePayload.platform_metadata;
	const identity = parseResourceIdentity(resource.kind, resource.resource_platform);
	if (!identity) {
		throw new Error(`Invalid resource identity: ${String(resource.kind)} / ${String(resource.resource_platform)}`);
	}
	const url = cleanString(resource.url);
	const tags = stringArrayValue(updatePayload.tags, 'tags');
	const keywords = stringArrayValue(updatePayload.keywords, 'keywords');
	const summary = cleanString(updatePayload.summary);
	const content = cleanString(updatePayload.content);
	return {
		id: resourceId,
		sourceId: cleanString(resource.source_id),
		kind: identity.kind,
		resourcePlatform: identity.resourcePlatform,
		type: parseResourceType(resource.type),
		scope: resource.scope,
		url,
		normalizedUrl: cleanString(resource.normalized_url),
		storageKey: cleanString(resource.storage_key),
		fileType: cleanString(resource.file_type),
		originalLang: canonicalizeResourceLang(resource.original_lang),
		title: cleanString(resource.title),
		summary,
		content,
		publishedDate:
			resource.published_date === null || resource.published_date === undefined || resource.published_date === ''
				? null
				: dateValue(resource.published_date, 'published_date'),
		scrapedDate: new Date(),
		keywords,
		tags,
		category: deriveResourceCategory(storedPlatformMetadata),
		ogImageUrl: cleanString(updatePayload.og_image_url),
		platformMetadataJson: storedPlatformMetadata === null ? null : JSON.stringify(storedPlatformMetadata),
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
			id, source_id, type, kind, resource_platform, scope, url, normalized_url, storage_key, file_type,
			original_lang, published_date, scraped_date, tags, category,
			og_image_url, platform_metadata, enrichment_status,
			created_at, updated_at
		)
		VALUES (
			${record.id}::uuid,
			${record.sourceId}::uuid,
			${record.type},
			${record.kind},
			${record.resourcePlatform},
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
		source_id = COALESCE(resources.source_id, excluded.source_id),
		type = CASE WHEN ${preserveEnriched} THEN resources.type ELSE excluded.type END,
		kind = CASE WHEN ${preserveEnriched} THEN resources.kind ELSE excluded.kind END,
		resource_platform = CASE
			WHEN ${preserveEnriched} THEN resources.resource_platform
			ELSE excluded.resource_platform
		END,
		scope = CASE
			WHEN resources.scope = 'corpus' OR excluded.scope = 'private' THEN resources.scope
			ELSE excluded.scope
		END,
		url = CASE WHEN ${preserveEnriched} THEN resources.url ELSE excluded.url END,
		storage_key = CASE WHEN ${preserveEnriched} THEN resources.storage_key ELSE excluded.storage_key END,
		file_type = CASE WHEN ${preserveEnriched} THEN resources.file_type ELSE excluded.file_type END,
		original_lang = CASE WHEN ${preserveEnriched} THEN resources.original_lang ELSE excluded.original_lang END,
		published_date = CASE
			WHEN ${preserveEnriched} THEN resources.published_date
			ELSE excluded.published_date
		END,
		scraped_date = CASE
			WHEN ${preserveEnriched} THEN resources.scraped_date
			ELSE excluded.scraped_date
		END,
		tags = CASE WHEN ${preserveEnriched} THEN resources.tags ELSE excluded.tags END,
		category = CASE WHEN ${preserveEnriched} THEN resources.category ELSE excluded.category END,
		og_image_url = CASE
			WHEN ${preserveEnriched} THEN resources.og_image_url
			ELSE excluded.og_image_url
		END,
		platform_metadata = CASE
			WHEN ${preserveEnriched} THEN resources.platform_metadata
			ELSE excluded.platform_metadata
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

type ResourceTranslationWrite = {
	resourceId: string;
	lang: string;
	title?: string | null;
	summary?: string | null;
	content?: string | null;
	keywords?: string[];
	source: ResourceTranslationSource;
};

/**
 * Row ownership is human > original > machine. Within the winning owner,
 * explicitly supplied fields replace current values; omitted fields are patches.
 */
export async function upsertResourceTranslation(db: CoreDb, input: ResourceTranslationWrite): Promise<boolean> {
	const keywords = textArraySql(input.keywords ?? []);
	const preserveCurrent = sql`
		(current_translation.source = 'human' AND excluded.source <> 'human')
		OR (current_translation.source = 'original' AND excluded.source = 'machine')
	`;
	const result = await db.execute(sql`
		WITH target_resource AS (
			SELECT resource.id
			FROM resources resource
			WHERE resource.id = ${input.resourceId}::uuid
			  AND (${input.source} <> 'original' OR resource.original_lang = ${input.lang})
		), demoted_originals AS (
			UPDATE resource_translations translation
			SET source = 'machine', updated_at = NOW()
			FROM target_resource
			WHERE ${input.source} = 'original'
			  AND translation.resource_id = target_resource.id
			  AND translation.lang <> ${input.lang}
			  AND translation.source = 'original'
			RETURNING translation.resource_id
		)
		INSERT INTO resource_translations AS current_translation (
			resource_id, lang, title, summary, content, keywords, source
		)
		SELECT
			target_resource.id,
			${input.lang},
			${input.title ?? null},
			${input.summary ?? null},
			${input.content ?? null},
			${keywords},
			${input.source}
		FROM target_resource
		ON CONFLICT (resource_id, lang) DO UPDATE SET
			title = CASE
				WHEN ${preserveCurrent} OR ${input.title === undefined} THEN current_translation.title
				ELSE excluded.title
			END,
			summary = CASE
				WHEN ${preserveCurrent} OR ${input.summary === undefined} THEN current_translation.summary
				ELSE excluded.summary
			END,
			content = CASE
				WHEN ${preserveCurrent} OR ${input.content === undefined} THEN current_translation.content
				ELSE excluded.content
			END,
			keywords = CASE
				WHEN ${preserveCurrent} OR ${input.keywords === undefined} THEN current_translation.keywords
				ELSE excluded.keywords
			END,
			source = CASE WHEN ${preserveCurrent} THEN current_translation.source ELSE excluded.source END,
			updated_at = NOW()
		RETURNING resource_id::text AS resource_id
	`);
	return result.rows.length > 0;
}

function cleanString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new Error(`Invalid resource field: expected string`);
	const trimmed = value.trim();
	return trimmed.length ? trimmed : null;
}

function requiredString(value: unknown, field: string): string {
	const text = cleanString(value);
	if (!text) throw new Error(`Invalid ${field}: expected non-empty string`);
	return text;
}

function storedPlatformMetadataValue(value: unknown, fallbackFetchedAt: string, resourceId: string): PlatformMetadata {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Invalid platform_metadata: expected object');
	}
	const metadata = value as Record<string, unknown>;
	const fetchedAt = typeof metadata.fetchedAt === 'string' ? metadata.fetchedAt.trim() : '';
	if (!fetchedAt) {
		console.warn({
			tag: 'RESOURCE',
			msg: 'Normalizing legacy platform metadata without fetchedAt',
			resource_id: resourceId,
			fallback_fetched_at: fallbackFetchedAt,
		});
		return {
			...metadata,
			data: Object.hasOwn(metadata, 'data') ? metadata.data : null,
			fetchedAt: fallbackFetchedAt,
		} as PlatformMetadata;
	}
	if (!Object.hasOwn(metadata, 'data')) throw new Error('Invalid platform_metadata: missing data');
	return value as PlatformMetadata;
}

function deriveResourceCategory(platformMetadata: unknown): ResourceCategory | null {
	if (platformMetadata && typeof platformMetadata === 'object' && !Array.isArray(platformMetadata)) {
		const category = (platformMetadata as { classification?: { category?: unknown } }).classification?.category;
		if (typeof category === 'string' && (RESOURCE_CATEGORIES as readonly string[]).includes(category)) return category as ResourceCategory;
	}
	return null;
}

function parseResourceType(value: unknown): ContentResourceType {
	if (!isContentResourceType(value)) throw new Error(`Resource type is not processable by core: ${String(value)}`);
	return value;
}

function parseResourceScope(value: unknown): ResourceScope {
	if (typeof value !== 'string' || !(RESOURCE_SCOPES as readonly string[]).includes(value)) {
		throw new Error(`Invalid resource scope: ${String(value)}`);
	}
	return value as ResourceScope;
}

function parseTranslationSource(value: unknown): ResourceTranslationSource | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string' || !(RESOURCE_TRANSLATION_SOURCES as readonly string[]).includes(value)) {
		throw new Error(`Invalid translation source: ${String(value)}`);
	}
	return value as ResourceTranslationSource;
}

export type ExistingResourceRecord = {
	id: string;
	url: string;
	type: ContentResourceType;
	shouldRetryEnrichment: boolean;
	needsSourceAttach: boolean;
};

export async function getExistingResourcesByUrl(db: CoreDb, urls: string[]): Promise<ExistingResourceRecord[]> {
	if (urls.length === 0) return [];
	const result = await db.execute<ExistingResourceRecord>(sql`
		SELECT
			r.id::text AS id,
			r.normalized_url AS url,
			r.type AS type,
			(
				r.enrichment_status = 'pending'
				OR (
					r.enrichment_status = 'failed'
					AND r.enrichment_attempts < ${MAX_ENRICHMENT_ATTEMPTS}
					-- 30m, 1h, 2h, 4h, then give up: a feed re-lists the same item for
					-- days, and a flat 30-minute window re-ran a dead URL every cycle.
					AND r.updated_at < NOW() - (INTERVAL '30 minutes' * POWER(2, GREATEST(r.enrichment_attempts, 1) - 1))
				)
			) AS "shouldRetryEnrichment",
			(r.source_id IS NULL) AS "needsSourceAttach"
		FROM resources r
			WHERE r.normalized_url = ANY(${textArraySql(urls)})
			  AND ${contentResourceIdentitySql({
					kind: sql`r.kind`,
					resourcePlatform: sql`r.resource_platform`,
					type: sql`r.type`,
				})}
	`);
	return result.rows;
}

/** Claims unowned rows for a source. Callers pass ids they just read, so the
 *  only guard that can still exclude anything is the unowned check itself. */
export async function attachSourceToResources(db: CoreDb, resourceIds: string[], sourceId: string): Promise<void> {
	if (!resourceIds.length) return;
	await assertResourceWritesEnabledInDb(db, 'attach monitored source to resources');
	await db.execute(sql`
		UPDATE resources
		SET source_id = ${sourceId}::uuid
		WHERE id = ANY(${uuidArraySql(resourceIds)})
		  AND source_id IS NULL
	`);
}

export async function reopenResourceForReprocessing(
	env: CoreEnv,
	resourceId: string,
	update: { content: string; platformMetadata: PlatformMetadata },
): Promise<boolean> {
	await assertResourceWritesEnabled(env, 'reopen resource for reprocessing');
	if (!update.content.trim()) {
		throw new Error(`Cannot reopen resource ${resourceId} with empty content`);
	}
	return withCoreTx(env, async (db) => {
		const resourceResult = await db.execute<{ original_lang: string }>(sql`
			SELECT original_lang
			FROM resources
			WHERE id = ${resourceId}::uuid
			FOR UPDATE
		`);
		const resource = resourceResult.rows[0];
		if (!resource) throw new Error(`Failed to reopen resource ${resourceId}: not found`);

		const translationResult = await db.execute<{
			summary: string | null;
			content: string | null;
			source: ResourceTranslationSource;
		}>(sql`
			SELECT summary, content, source
			FROM resource_translations
			WHERE resource_id = ${resourceId}::uuid
			  AND lang = ${resource.original_lang}
			FOR UPDATE
		`);
		const original = translationResult.rows[0];
		if (!original) throw new Error(`Failed to reopen resource ${resourceId}: original translation not found`);

		const preserveOwnedTranslation = original.source === 'human';
		const effectiveContent = preserveOwnedTranslation ? original.content : update.content;
		const sourceSummaryChanged = !preserveOwnedTranslation && original.summary !== null;
		const sourceContentChanged = original.content !== effectiveContent;
		if (!sourceSummaryChanged && !sourceContentChanged) return false;

		await db
			.update(resources)
			.set({
				platformMetadata: update.platformMetadata,
				enrichmentStatus: 'pending',
				updatedAt: sql`NOW()`,
			})
			.where(eq(resources.id, resourceId));
		if (
			!(await upsertResourceTranslation(db, {
				resourceId,
				lang: resource.original_lang,
				summary: null,
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
