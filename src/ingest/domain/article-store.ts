import type { Article } from '@core-shared/types';
import { Client } from 'pg';

type ArticleStoreTable = 'articles' | 'user_files';

type ArticleForProcessing = Article & { has_content?: boolean };

const ARTICLE_FIELDS: Record<ArticleStoreTable, string> = {
	articles:
		'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, platform_metadata, entities',
	user_files:
		'id, title, title_cn, summary, summary_cn, extracted_text AS content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, metadata AS platform_metadata, entities, storage_key, file_type',
};

const ARTICLE_SHELL_FIELDS: Record<ArticleStoreTable, string> = {
	articles:
		'id, title, title_cn, summary, summary_cn, NULL::text AS content, content IS NOT NULL AND length(content) > 0 AS has_content, url, source, source_type, published_date, tags, keywords, platform_metadata, entities',
	user_files:
		'id, title, title_cn, summary, summary_cn, NULL::text AS content, extracted_text IS NOT NULL AND length(extracted_text) > 0 AS has_content, source_url AS url, site_name AS source, platform_type AS source_type, published_date, tags, keywords, metadata AS platform_metadata, entities, storage_key, file_type',
};

export async function loadArticleForProcessing(
	env: Env,
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

export async function getUserFileWorkflowInstanceId(db: Client, userFileId: string): Promise<string | null> {
	const result = await db.query(`SELECT metadata->'workflow'->>'monitor_instance_id' AS instance_id FROM user_files WHERE id = $1`, [
		userFileId,
	]);
	const row = result.rows[0] as { instance_id?: string | null } | undefined;
	return row?.instance_id ?? null;
}

export async function patchUserFileWorkflowMetadata(db: Client, userFileId: string, patch: Record<string, string>): Promise<void> {
	await db.query(
		`UPDATE user_files
		 SET metadata = jsonb_set(
		   COALESCE(metadata, '{}'::jsonb),
		   '{workflow}',
		   COALESCE(metadata->'workflow', '{}'::jsonb) || $1::jsonb,
		   TRUE
		 )
		 WHERE id = $2`,
		[JSON.stringify(patch), userFileId],
	);
}

export interface PreparedArticleRecord {
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

export function preparedArticleToArticle(data: PreparedArticleRecord): Article {
	return {
		id: data.url,
		title: data.title,
		title_cn: null,
		summary: data.summary || null,
		summary_cn: null,
		content: data.content,
		content_cn: null,
		url: data.url,
		source: data.source,
		published_date: typeof data.publishedDate === 'string' ? data.publishedDate : data.publishedDate.toISOString(),
		tags: data.tags ?? [],
		keywords: data.keywords ?? [],
		source_type: data.sourceType,
		platform_metadata: data.platformMetadata as Article['platform_metadata'],
	};
}

type ArticleProcessingUpdate = Record<string, unknown>;

const ARTICLES_TO_USER_FILES_COLUMN_MAP: Record<string, string> = {
	content: 'extracted_text',
	platform_metadata: 'metadata',
};

export async function updateArticleAfterProcessing(
	db: Client,
	table: ArticleStoreTable,
	articleId: string,
	updatePayload: ArticleProcessingUpdate,
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
	updatePayload: ArticleProcessingUpdate,
): Promise<string> {
	const platformMetadata = updatePayload.platform_metadata ?? base.platformMetadata;
	const entities = updatePayload.entities ?? null;
	const ogImageUrl = Object.hasOwn(updatePayload, 'og_image_url') ? updatePayload.og_image_url : base.ogImageUrl;
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
			ogImageUrl,
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

type ExistingArticleRecord = {
	id: string;
	url: string;
	source: string;
	source_type: string;
	summary_cn: string | null;
};

export async function getExistingArticlesByUrl(db: Client, urls: string[], batchSize = 50): Promise<ExistingArticleRecord[]> {
	const records: ExistingArticleRecord[] = [];
	if (urls.length === 0) return records;

	for (let i = 0; i < urls.length; i += batchSize) {
		const batch = urls.slice(i, i + batchSize);
		const result = await db.query<ExistingArticleRecord>(
			'SELECT id, url, source, source_type, summary_cn FROM articles WHERE url = ANY($1)',
			[batch],
		);
		records.push(...result.rows);
	}

	return records;
}

export async function getExistingArticleByUrl(db: Client, url: string): Promise<ExistingArticleRecord | null> {
	const [article] = await getExistingArticlesByUrl(db, [url], 1);
	return article ?? null;
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

export async function getIncompleteWorkflowTargetIds(
	db: Client,
	since: Date | string,
): Promise<{ articleIds: string[]; userFileIds: string[] }> {
	const articleResult = await db.query<{ id: string }>(
		`SELECT id FROM articles
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
		`SELECT id FROM user_files
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
