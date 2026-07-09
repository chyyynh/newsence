import type { Article } from '@core-shared/types';
import { type CoreDb, withCoreDb } from '@db/client';
import { articleEntities, articles, entities, resourceEntities, userFiles } from '@db/schema';
import { type ArticleEntityInput, canonicalizeEntityName, normalizeArticleEntitiesForStorage } from '@entities/normalize';
import { and, eq, inArray, not, type SQL, sql } from 'drizzle-orm';
import { RESOURCE_CATEGORIES, RESOURCE_TYPES, type ResourceCategory, type ResourceType } from '../../resources/types';

type ArticleStoreTable = 'articles' | 'user_files';

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
	source_type: string | null;
	published_date: Date | string | null;
	tags: string[];
	keywords: string[];
	platform_metadata: unknown;
	has_content?: boolean;
	storage_key?: string | null;
	file_type?: string;
	normalized_source_url?: string | null;
	resource_kind?: string;
	origin_type?: string;
}

export async function loadArticleForProcessing(
	env: CoreEnv,
	table: ArticleStoreTable,
	articleId: string,
	shell = false,
): Promise<ArticleForProcessing> {
	if (table !== 'articles' && table !== 'user_files') throw new Error(`Unsupported article store table: ${table}`);
	return withCoreDb(env, async (db) => {
		const row = table === 'articles' ? await loadStoredArticleRow(db, articleId, shell) : await loadStoredUserFileRow(db, articleId, shell);
		if (!row) throw new Error(`Failed to fetch article ${articleId}: not found`);
		return row;
	});
}

export async function isUserFileEnrichmentComplete(env: CoreEnv, userFileId: string): Promise<boolean> {
	return withCoreDb(env, async (db) => {
		const row = (
			await db
				.select({
					complete: sql<boolean>`${userFiles.titleCn} IS NOT NULL
						AND length(${userFiles.titleCn}) > 0
						AND ${userFiles.summaryCn} IS NOT NULL
						AND length(${userFiles.summaryCn}) > 0
						AND ${userFiles.embedding} IS NOT NULL`,
				})
				.from(userFiles)
				.where(eq(userFiles.id, userFileId))
				.limit(1)
		)[0];
		if (!row) throw new Error(`Failed to fetch user_file ${userFileId}: not found`);
		return row.complete;
	});
}

async function loadStoredArticleRow(db: CoreDb, articleId: string, shell: boolean): Promise<ArticleForProcessing | undefined> {
	if (shell) {
		const [row] = await db
			.select({
				id: articles.id,
				title: articles.title,
				title_cn: articles.titleCn,
				summary: articles.summary,
				summary_cn: articles.summaryCn,
				content: sql<string | null>`NULL::text`,
				has_content: sql<boolean>`${articles.content} IS NOT NULL AND length(${articles.content}) > 0`,
				url: articles.url,
				og_image_url: articles.ogImageUrl,
				source: articles.source,
				source_type: articles.sourceType,
				published_date: articles.publishedDate,
				tags: articles.tags,
				keywords: articles.keywords,
				platform_metadata: articles.platformMetadata,
			})
			.from(articles)
			.where(eq(articles.id, articleId))
			.limit(1);
		return row ? articleStoreRowToProcessing(row) : undefined;
	}

	const [row] = await db
		.select({
			id: articles.id,
			title: articles.title,
			title_cn: articles.titleCn,
			summary: articles.summary,
			summary_cn: articles.summaryCn,
			content: articles.content,
			url: articles.url,
			og_image_url: articles.ogImageUrl,
			source: articles.source,
			source_type: articles.sourceType,
			published_date: articles.publishedDate,
			tags: articles.tags,
			keywords: articles.keywords,
			platform_metadata: articles.platformMetadata,
		})
		.from(articles)
		.where(eq(articles.id, articleId))
		.limit(1);
	return row ? articleStoreRowToProcessing(row) : undefined;
}

async function loadStoredUserFileRow(db: CoreDb, articleId: string, shell: boolean): Promise<ArticleForProcessing | undefined> {
	if (shell) {
		const [row] = await db
			.select({
				id: userFiles.id,
				title: userFiles.title,
				title_cn: userFiles.titleCn,
				summary: userFiles.summary,
				summary_cn: userFiles.summaryCn,
				content: sql<string | null>`NULL::text`,
				has_content: sql<boolean>`${userFiles.extractedText} IS NOT NULL AND length(${userFiles.extractedText}) > 0`,
				url: userFiles.sourceUrl,
				og_image_url: userFiles.ogImageUrl,
				source: userFiles.siteName,
				source_type: userFiles.platformType,
				published_date: userFiles.publishedDate,
				tags: userFiles.tags,
				keywords: userFiles.keywords,
				platform_metadata: userFiles.metadata,
				storage_key: userFiles.storageKey,
				file_type: userFiles.fileType,
				normalized_source_url: userFiles.normalizedSourceUrl,
				resource_kind: userFiles.resourceKind,
				origin_type: userFiles.originType,
			})
			.from(userFiles)
			.where(eq(userFiles.id, articleId))
			.limit(1);
		return row ? articleStoreRowToProcessing(row) : undefined;
	}

	const [row] = await db
		.select({
			id: userFiles.id,
			title: userFiles.title,
			title_cn: userFiles.titleCn,
			summary: userFiles.summary,
			summary_cn: userFiles.summaryCn,
			content: userFiles.extractedText,
			url: userFiles.sourceUrl,
			og_image_url: userFiles.ogImageUrl,
			source: userFiles.siteName,
			source_type: userFiles.platformType,
			published_date: userFiles.publishedDate,
			tags: userFiles.tags,
			keywords: userFiles.keywords,
			platform_metadata: userFiles.metadata,
			storage_key: userFiles.storageKey,
			file_type: userFiles.fileType,
			normalized_source_url: userFiles.normalizedSourceUrl,
			resource_kind: userFiles.resourceKind,
			origin_type: userFiles.originType,
		})
		.from(userFiles)
		.where(eq(userFiles.id, articleId))
		.limit(1);
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
		source_type: row.source_type ?? undefined,
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

interface PreparedArticleRecord {
	url: string;
	title: string;
	source: string;
	publishedDate: Date | string;
	summary: string;
	sourceType: string;
	content: string | null;
	platformMetadata: unknown | null;
	keywords?: string[];
	tags?: string[];
}

type ArticleUpdateValues = Partial<typeof articles.$inferInsert>;
type UserFileUpdateValues = Partial<typeof userFiles.$inferInsert>;
type ArticleStoreResourceTable = 'articles' | 'user_files';

interface ResourceMirrorRecord {
	id: string;
	type: ResourceType;
	scope: 'corpus' | 'private';
	url: string | null;
	normalizedUrl: string | null;
	storageKey: string | null;
	fileType: string | null;
	title: string | null;
	titleCn: string | null;
	summary: string | null;
	summaryCn: string | null;
	content: string | null;
	contentCn: string | null;
	source: string | null;
	publishedDate: Date | null;
	scrapedDate: Date;
	keywords: string[];
	tags: string[];
	category: ResourceCategory | null;
	entitiesJson: string | null;
	ogImageUrl: string | null;
	platformMetadataJson: string | null;
	embedding: string | null;
}

function articleUpdateValues(updatePayload: Record<string, unknown>): ArticleUpdateValues {
	const update: ArticleUpdateValues = {};
	for (const [key, value] of Object.entries(updatePayload)) {
		if (value === undefined) continue;
		switch (key) {
			case 'title':
				update.title = requiredString(value, key);
				break;
			case 'title_cn':
				update.titleCn = nullableString(value, key);
				break;
			case 'summary':
				update.summary = nullableString(value, key);
				break;
			case 'summary_cn':
				update.summaryCn = nullableString(value, key);
				break;
			case 'content':
				update.content = nullableString(value, key);
				break;
			case 'content_cn':
				update.contentCn = nullableString(value, key);
				break;
			case 'og_image_url':
				update.ogImageUrl = nullableString(value, key);
				break;
			case 'source':
				update.source = requiredString(value, key);
				break;
			case 'source_type':
				update.sourceType = requiredString(value, key);
				break;
			case 'published_date':
				update.publishedDate = dateValue(value, key);
				break;
			case 'tags':
				update.tags = stringArrayValue(value, key);
				break;
			case 'keywords':
				update.keywords = stringArrayValue(value, key);
				break;
			case 'platform_metadata':
				update.platformMetadata = value;
				break;
			case 'entities':
				update.entities = value;
				break;
			case 'embedding':
				update.embedding = nullableVector(value, key);
				break;
			default:
				throw new Error(`Unsupported articles update column: ${key}`);
		}
	}
	return update;
}

function userFileUpdateValues(updatePayload: Record<string, unknown>): UserFileUpdateValues {
	const update: UserFileUpdateValues = {};
	for (const [key, value] of Object.entries(updatePayload)) {
		if (value === undefined) continue;
		switch (key) {
			case 'title':
				update.title = nullableString(value, key);
				break;
			case 'title_cn':
				update.titleCn = nullableString(value, key);
				break;
			case 'summary':
				update.summary = nullableString(value, key);
				break;
			case 'summary_cn':
				update.summaryCn = nullableString(value, key);
				break;
			case 'content':
				update.extractedText = nullableString(value, key);
				break;
			case 'content_cn':
				update.contentCn = nullableString(value, key);
				break;
			case 'og_image_url':
				update.ogImageUrl = nullableString(value, key);
				break;
			case 'source':
				update.siteName = nullableString(value, key);
				break;
			case 'source_type':
				update.platformType = nullableString(value, key);
				break;
			case 'published_date':
				update.publishedDate = value === null ? null : dateValue(value, key);
				break;
			case 'tags':
				update.tags = stringArrayValue(value, key);
				break;
			case 'keywords':
				update.keywords = stringArrayValue(value, key);
				break;
			case 'platform_metadata':
				update.metadata = value;
				break;
			case 'entities':
				update.entities = value;
				break;
			case 'embedding':
				update.embedding = nullableVector(value, key);
				break;
			default:
				throw new Error(`Unsupported user_files update column: ${key}`);
		}
	}
	return update;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new Error(`Invalid ${field}: expected string`);
	return value;
}

function nullableString(value: unknown, field: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new Error(`Invalid ${field}: expected string`);
	return value;
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
 * - Source articles are globally unique by URL. Discovery may pre-query with
 *   getExistingArticlesByUrl, but insertFinalSourceArticle is the authoritative
 *   ON CONFLICT guard.
 * - user_files rows are created by the app worker. Saved URLs dedup per user on
 *   (user_id, normalized_source_url); blob uploads intentionally keep one row
 *   per upload. Core only updates enrichment fields here.
 */
export async function updateArticleAfterProcessing(
	db: CoreDb,
	table: ArticleStoreTable,
	articleId: string,
	updatePayload: Record<string, unknown>,
): Promise<void> {
	if (table !== 'articles' && table !== 'user_files') throw new Error(`Unsupported article store table: ${table}`);
	const updated =
		table === 'articles'
			? await updateStoredArticle(db, articleId, updatePayload)
			: await updateStoredUserFile(db, articleId, updatePayload);
	if (updated.length === 0) {
		throw new Error(`Failed to update article ${articleId}: no rows matched`);
	}
}

async function updateStoredArticle(db: CoreDb, articleId: string, updatePayload: Record<string, unknown>): Promise<Array<{ id: string }>> {
	const values = articleUpdateValues(updatePayload);
	if (Object.keys(values).length === 0) return [{ id: articleId }];
	return db.update(articles).set(values).where(eq(articles.id, articleId)).returning({ id: articles.id });
}

async function updateStoredUserFile(db: CoreDb, articleId: string, updatePayload: Record<string, unknown>): Promise<Array<{ id: string }>> {
	const values = userFileUpdateValues(updatePayload);
	if (Object.keys(values).length === 0) return [{ id: articleId }];
	return db.update(userFiles).set(values).where(eq(userFiles.id, articleId)).returning({ id: userFiles.id });
}

export async function syncResourceAfterProcessing(
	db: CoreDb,
	table: ArticleStoreResourceTable,
	legacyId: string,
	article: Article,
	updatePayload: Record<string, unknown>,
): Promise<string> {
	const record = resourceMirrorRecord(table, legacyId, article, updatePayload);
	const result = await db.execute(resourceUpsertStatement(record));
	const resourceId = (result.rows as Array<{ id?: string }>)[0]?.id;
	if (!resourceId) throw new Error(`Failed to sync resource mirror for ${table}:${legacyId}`);
	return resourceId;
}

function resourceMirrorRecord(
	table: ArticleStoreResourceTable,
	legacyId: string,
	article: Article,
	updatePayload: Record<string, unknown>,
): ResourceMirrorRecord {
	const platformMetadata = updatePayload.platform_metadata ?? article.platform_metadata ?? null;
	const fileType = stringOrNull(article.file_type);
	const url = cleanString(updatePayload.url ?? article.url);
	const normalizedUrl = table === 'user_files' ? cleanString(article.normalized_source_url ?? article.url) : url;
	const tags = stringArrayValue(updatePayload.tags ?? article.tags ?? [], 'tags');
	const keywords = stringArrayValue(updatePayload.keywords ?? article.keywords ?? [], 'keywords');
	return {
		id: legacyId,
		type: deriveResourceType({
			table,
			platformMetadata,
			sourceType: stringOrNull(updatePayload.source_type ?? article.source_type),
			fileType,
			resourceKind: article.resource_kind ?? null,
		}),
		scope: table === 'articles' || article.resource_kind === 'url' ? 'corpus' : 'private',
		url,
		normalizedUrl,
		storageKey: cleanString(article.storage_key),
		fileType,
		title: cleanString(updatePayload.title ?? article.title),
		titleCn: cleanString(updatePayload.title_cn ?? article.title_cn),
		summary: cleanString(updatePayload.summary ?? article.summary),
		summaryCn: cleanString(updatePayload.summary_cn ?? article.summary_cn),
		content: cleanString(updatePayload.content ?? article.content),
		contentCn: cleanString(updatePayload.content_cn ?? article.content_cn),
		source: cleanString(updatePayload.source ?? article.source),
		publishedDate: optionalDateValue(updatePayload.published_date ?? article.published_date, 'published_date'),
		scrapedDate: new Date(),
		keywords,
		tags,
		category: deriveResourceCategory(platformMetadata, tags),
		entitiesJson: jsonbParam(updatePayload.entities ?? null),
		ogImageUrl: cleanString(updatePayload.og_image_url ?? article.og_image_url),
		platformMetadataJson: jsonbParam(platformMetadata),
		embedding: nullableVector(updatePayload.embedding, 'embedding'),
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
			title, title_cn, summary, summary_cn, content, content_cn, source,
			published_date, scraped_date, keywords, tags, category, entities,
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
			${record.title},
			${record.titleCn},
			${record.summary},
			${record.summaryCn},
			${record.content},
			${record.contentCn},
			${record.source},
			${record.publishedDate},
			${record.scrapedDate},
			${record.keywords}::text[],
			${record.tags}::text[],
			${record.category},
			${record.entitiesJson}::jsonb,
			${record.ogImageUrl},
			${record.platformMetadataJson}::jsonb,
			${record.embedding}::vector,
			'enriched',
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
		title = COALESCE(NULLIF(excluded.title, ''), resources.title),
		title_cn = COALESCE(NULLIF(excluded.title_cn, ''), resources.title_cn),
		summary = COALESCE(NULLIF(excluded.summary, ''), resources.summary),
		summary_cn = COALESCE(NULLIF(excluded.summary_cn, ''), resources.summary_cn),
		content = COALESCE(NULLIF(excluded.content, ''), resources.content),
		content_cn = COALESCE(NULLIF(excluded.content_cn, ''), resources.content_cn),
		source = COALESCE(NULLIF(excluded.source, ''), resources.source),
		published_date = COALESCE(excluded.published_date, resources.published_date),
		scraped_date = COALESCE(excluded.scraped_date, resources.scraped_date),
		keywords = CASE WHEN cardinality(excluded.keywords) > 0 THEN excluded.keywords ELSE resources.keywords END,
		tags = CASE WHEN cardinality(excluded.tags) > 0 THEN excluded.tags ELSE resources.tags END,
		category = COALESCE(excluded.category, resources.category),
		entities = COALESCE(excluded.entities, resources.entities),
		og_image_url = COALESCE(NULLIF(excluded.og_image_url, ''), resources.og_image_url),
		platform_metadata = COALESCE(excluded.platform_metadata, resources.platform_metadata),
		embedding = COALESCE(excluded.embedding, resources.embedding),
		enrichment_status = excluded.enrichment_status,
		updated_at = now()
	`;
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
	table: ArticleStoreResourceTable;
	platformMetadata: unknown;
	sourceType: string | null;
	fileType: string | null;
	resourceKind: string | null;
}): ResourceType {
	const metadataType = platformMetadataType(input.platformMetadata);
	if (metadataType) return metadataType;
	if (isResourceType(input.sourceType)) return input.sourceType;
	if (input.fileType === 'application/pdf') return 'pdf';
	if (input.fileType?.startsWith('image/')) return 'image';
	if (input.table === 'user_files' && input.resourceKind === 'url') return 'web';
	return input.table === 'user_files' ? 'file' : 'web';
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

export async function insertFinalSourceArticle(
	db: CoreDb,
	base: PreparedArticleRecord,
	updatePayload: Record<string, unknown>,
): Promise<string> {
	const platformMetadata = updatePayload.platform_metadata ?? base.platformMetadata;
	const entities = updatePayload.entities ?? null;
	const inserted = await db
		.insert(articles)
		.values({
			url: base.url,
			title: base.title,
			titleCn: nullableString(updatePayload.title_cn, 'title_cn'),
			source: base.source,
			publishedDate: dateValue(base.publishedDate, 'publishedDate'),
			scrapedDate: new Date(),
			keywords: stringArrayValue(updatePayload.keywords ?? base.keywords ?? [], 'keywords'),
			tags: stringArrayValue(updatePayload.tags ?? base.tags ?? [], 'tags'),
			tokens: [],
			summary: nullableString(updatePayload.summary ?? base.summary, 'summary'),
			summaryCn: nullableString(updatePayload.summary_cn, 'summary_cn'),
			sourceType: base.sourceType,
			content: nullableString(updatePayload.content ?? base.content, 'content'),
			contentCn: nullableString(updatePayload.content_cn, 'content_cn'),
			ogImageUrl: nullableString(updatePayload.og_image_url, 'og_image_url'),
			platformMetadata,
			entities,
			embedding: nullableVector(updatePayload.embedding, 'embedding'),
		})
		.onConflictDoNothing({ target: articles.url })
		.returning({ id: articles.id });
	const articleId =
		inserted[0]?.id ?? (await db.select({ id: articles.id }).from(articles).where(eq(articles.url, base.url)).limit(1))[0]?.id;
	if (!articleId) throw new Error(`Failed to insert finalized article for ${base.url}`);
	return articleId;
}

export async function syncArticleEntities(
	db: CoreDb,
	articleId: string,
	inputEntities: ArticleEntityInput[],
	source?: string | null,
	platformMetadata?: unknown,
): Promise<void> {
	const existingLinks = await db
		.select({ entityId: articleEntities.entityId })
		.from(articleEntities)
		.where(eq(articleEntities.articleId, articleId));
	const { normalizedEntities, entityIds } = await upsertEntityIds(db, inputEntities, source, platformMetadata);

	if (entityIds.length) {
		await db
			.delete(articleEntities)
			.where(and(eq(articleEntities.articleId, articleId), not(inArray(articleEntities.entityId, entityIds))));
	} else {
		await db.delete(articleEntities).where(eq(articleEntities.articleId, articleId));
	}

	for (const entityId of entityIds) {
		await db.insert(articleEntities).values({ articleId, entityId }).onConflictDoNothing();
	}

	await refreshEntityArticleCounts(db, [...existingLinks.map((row) => row.entityId), ...entityIds]);

	console.info({
		tag: 'ENTITIES',
		msg: 'Synced',
		articleId,
		inputCount: inputEntities.length,
		count: normalizedEntities.length,
		filteredCount: inputEntities.length - normalizedEntities.length,
	});
}

export async function syncResourceEntities(
	db: CoreDb,
	resourceId: string,
	inputEntities: ArticleEntityInput[],
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

	await refreshEntityArticleCounts(db, [...existingLinks.map((row) => row.entityId), ...entityIds]);

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
	inputEntities: ArticleEntityInput[],
	source?: string | null,
	platformMetadata?: unknown,
): Promise<{ normalizedEntities: ArticleEntityInput[]; entityIds: string[] }> {
	const normalizedEntities = normalizeArticleEntitiesForStorage(inputEntities, source, platformMetadata);
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
	}

	return { normalizedEntities, entityIds };
}

async function refreshEntityArticleCounts(db: CoreDb, entityIds: string[]): Promise<void> {
	const uniqueIds = [...new Set(entityIds)];
	if (!uniqueIds.length) return;
	await db.execute(sql`
		UPDATE entities e
		    SET article_count = counts.article_count
		   FROM (
		     SELECT ids.id, COUNT(DISTINCT links.resource_id)::int AS article_count
		       FROM unnest(${uniqueIds}::uuid[]) AS ids(id)
		       LEFT JOIN (
		         SELECT article_id AS resource_id, entity_id FROM article_entities
		         UNION
		         SELECT resource_id, entity_id FROM resource_entities
		       ) links ON links.entity_id = ids.id
		      GROUP BY ids.id
		   ) counts
		  WHERE e.id = counts.id
	`);
}

type ExistingArticleRecord = {
	id: string;
	url: string;
	source: string;
	source_type: string;
	summary_cn: string | null;
};

export async function getExistingArticlesByUrl(db: CoreDb, urls: string[]): Promise<ExistingArticleRecord[]> {
	if (urls.length === 0) return [];
	return db
		.select({
			id: articles.id,
			url: articles.url,
			source: articles.source,
			source_type: articles.sourceType,
			summary_cn: articles.summaryCn,
		})
		.from(articles)
		.where(inArray(articles.url, urls));
}

export async function reopenArticleForReprocessing(
	db: CoreDb,
	articleId: string,
	update: { summary: string; content: string; platformMetadata: unknown },
): Promise<void> {
	await db
		.update(articles)
		.set({
			summary: update.summary,
			content: update.content,
			platformMetadata: update.platformMetadata,
			summaryCn: null,
			contentCn: null,
			titleCn: null,
			embedding: null,
		})
		.where(eq(articles.id, articleId));
}
