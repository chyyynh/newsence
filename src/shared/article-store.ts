import { type DbClient, withDbClient } from './db';
import type { Article, Env } from './types';
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
	entities: Array<{ name: string; name_cn: string; type: string }>,
): Promise<void> {
	if (!entities.length) return;

	for (const entity of entities) {
		const canonical = entity.name.toLowerCase().trim();
		if (!canonical) continue;

		try {
			const result = await db.query(
				`INSERT INTO entities (canonical_name, name, name_cn, type)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (canonical_name) DO UPDATE SET
				   updated_at = NOW()
				 RETURNING id`,
				[canonical, entity.name, entity.name_cn, entity.type],
			);
			const entityId = result.rows[0]?.id;
			if (!entityId) continue;

			await db.query(`INSERT INTO article_entities (article_id, entity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [articleId, entityId]);
		} catch (err) {
			console.error({ tag: 'ENTITIES', msg: 'Failed to sync entity', entity: entity.name, error: String(err) });
		}
	}

	console.info({ tag: 'ENTITIES', msg: 'Synced', articleId, count: entities.length });
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
