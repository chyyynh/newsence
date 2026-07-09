import type { Article } from '@core-shared/types';
import { type CoreDb, withCoreDb } from '@db/client';
import { articleEntities, articles, entities, userFiles } from '@db/schema';
import { type ArticleEntityInput, canonicalizeEntityName, normalizeArticleEntitiesForStorage } from '@entities/normalize';
import { and, eq, inArray, not, sql } from 'drizzle-orm';

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
	const normalizedEntities = normalizeArticleEntitiesForStorage(inputEntities, source, platformMetadata);
	const entityIds: string[] = [];
	const existingLinks = await db
		.select({ entityId: articleEntities.entityId })
		.from(articleEntities)
		.where(eq(articleEntities.articleId, articleId));

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

async function refreshEntityArticleCounts(db: CoreDb, entityIds: string[]): Promise<void> {
	const uniqueIds = [...new Set(entityIds)];
	if (!uniqueIds.length) return;
	await db.execute(sql`
		UPDATE entities e
		    SET article_count = counts.article_count
		   FROM (
		     SELECT ids.id, COUNT(ae.article_id)::int AS article_count
		       FROM unnest(${uniqueIds}::uuid[]) AS ids(id)
		       LEFT JOIN article_entities ae ON ae.entity_id = ids.id
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
