import type { Article } from '@core-shared/types';
import { type ArticleEntityInput, canonicalizeEntityName, normalizeArticleEntitiesForStorage } from '@entities/normalize';
import { Client } from 'pg';

type ArticleStoreTable = 'articles' | 'user_files';

type ArticleForProcessing = Article & { has_content?: boolean };

const ARTICLE_FIELDS: Record<ArticleStoreTable, string> = {
	articles:
		'id, title, title_cn, summary, summary_cn, content, url, og_image_url, source, source_type, published_date, tags, keywords, platform_metadata, entities',
	user_files:
		'id, title, title_cn, summary, summary_cn, extracted_text AS content, source_url AS url, og_image_url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, metadata AS platform_metadata, entities, storage_key, file_type',
};

const ARTICLE_SHELL_FIELDS: Record<ArticleStoreTable, string> = {
	articles:
		'id, title, title_cn, summary, summary_cn, NULL::text AS content, content IS NOT NULL AND length(content) > 0 AS has_content, url, og_image_url, source, source_type, published_date, tags, keywords, platform_metadata, entities',
	user_files:
		'id, title, title_cn, summary, summary_cn, NULL::text AS content, extracted_text IS NOT NULL AND length(extracted_text) > 0 AS has_content, source_url AS url, og_image_url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, metadata AS platform_metadata, entities, storage_key, file_type',
};

export async function loadArticleForProcessing(
	env: CoreEnv,
	table: ArticleStoreTable,
	articleId: string,
	shell = false,
): Promise<ArticleForProcessing> {
	if (table !== 'articles' && table !== 'user_files') throw new Error(`Unsupported article store table: ${table}`);
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const result = await db.query(`SELECT ${shell ? ARTICLE_SHELL_FIELDS[table] : ARTICLE_FIELDS[table]} FROM ${table} WHERE id = $1`, [
		articleId,
	]);
	if (result.rows.length === 0) throw new Error(`Failed to fetch article ${articleId}: not found`);
	return result.rows[0] as ArticleForProcessing;
}

export async function isUserFileEnrichmentComplete(env: CoreEnv, userFileId: string): Promise<boolean> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const row = (
		await db.query<{ complete: boolean }>(
			`SELECT title_cn IS NOT NULL
			        AND length(title_cn) > 0
			        AND summary_cn IS NOT NULL
			        AND length(summary_cn) > 0
			        AND embedding IS NOT NULL AS complete
			   FROM user_files
			  WHERE id = $1
			  LIMIT 1`,
			[userFileId],
		)
	).rows[0];
	if (!row) throw new Error(`Failed to fetch user_file ${userFileId}: not found`);
	return row.complete;
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
