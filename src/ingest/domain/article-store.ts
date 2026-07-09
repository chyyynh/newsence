import type { Article } from '@core-shared/types';
import { type CoreDb, withCoreDb } from '@db/client';
import { articles, userFiles } from '@db/schema';
import { type ArticleEntityInput, canonicalizeEntityName, normalizeArticleEntitiesForStorage } from '@entities/normalize';
import { eq, sql } from 'drizzle-orm';
import type { Client } from 'pg';

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

const ARTICLES_TO_USER_FILES_COLUMN_MAP: Record<string, string> = {
	content: 'extracted_text',
	platform_metadata: 'metadata',
	source: 'site_name',
	source_type: 'platform_type',
};

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
	db: Client,
	table: ArticleStoreTable,
	articleId: string,
	updatePayload: Record<string, unknown>,
): Promise<void> {
	if (table !== 'articles' && table !== 'user_files') throw new Error(`Unsupported article store table: ${table}`);
	const columns = Object.keys(updatePayload);
	if (columns.length === 0) return;

	const setClauses = columns
		.map((col, i) => `${table === 'user_files' ? (ARTICLES_TO_USER_FILES_COLUMN_MAP[col] ?? col) : col} = $${i + 1}`)
		.join(', ');
	const values = columns.map((col) => {
		const value = updatePayload[col];
		return value !== null && typeof value === 'object' && col !== 'tags' && col !== 'keywords' ? JSON.stringify(value) : value;
	});
	values.push(articleId);

	const sql = `UPDATE ${table} SET ${setClauses} WHERE id = $${values.length}`;
	const queryResult = await db.query(sql, values);
	if (queryResult.rowCount === 0) {
		throw new Error(`Failed to update article ${articleId}: no rows matched`);
	}
}

export async function insertFinalSourceArticle(
	db: Client,
	base: PreparedArticleRecord,
	updatePayload: Record<string, unknown>,
): Promise<string> {
	const platformMetadata = updatePayload.platform_metadata ?? base.platformMetadata;
	const entities = updatePayload.entities ?? null;
	const inserted = await db.query<{ id: string }>(
		`INSERT INTO articles (
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
			updatePayload.og_image_url ?? null,
			platformMetadata ? JSON.stringify(platformMetadata) : null,
			entities ? JSON.stringify(entities) : null,
			updatePayload.embedding ?? null,
		],
	);
	const articleId =
		inserted.rows[0]?.id ?? (await db.query<{ id: string }>('SELECT id FROM articles WHERE url = $1 LIMIT 1', [base.url])).rows[0]?.id;
	if (!articleId) throw new Error(`Failed to insert finalized article for ${base.url}`);
	return articleId;
}

export async function syncArticleEntities(
	db: Client,
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

async function refreshEntityArticleCounts(db: Client, entityIds: string[]): Promise<void> {
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

type ExistingArticleRecord = {
	id: string;
	url: string;
	source: string;
	source_type: string;
	summary_cn: string | null;
};

export async function getExistingArticlesByUrl(db: Client, urls: string[]): Promise<ExistingArticleRecord[]> {
	if (urls.length === 0) return [];
	return (
		await db.query<ExistingArticleRecord>('SELECT id, url, source, source_type, summary_cn FROM articles WHERE url = ANY($1)', [urls])
	).rows;
}

export async function reopenArticleForReprocessing(
	db: Client,
	articleId: string,
	update: { summary: string; content: string; platformMetadata: unknown },
): Promise<void> {
	await db.query(
		`UPDATE articles
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
