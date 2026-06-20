import { Client } from 'pg';
import type { Article, Env, RSSFeed } from './types';
import { normalizeUrl } from './web';
export type DbClient = Client;

export async function createDbClient(env: Env): Promise<Client> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return client;
}

export async function withDbClient<T>(env: Env, fn: (db: DbClient) => Promise<T>): Promise<T> {
	const db = await createDbClient(env);
	try {
		return await fn(db);
	} finally {
		await db.end();
	}
}

export async function withDbTransaction<T>(env: Env, rollbackContext: string, fn: (db: DbClient) => Promise<T>): Promise<T> {
	return withDbClient(env, async (db) => {
		try {
			await db.query('BEGIN');
			const result = await fn(db);
			await db.query('COMMIT');
			return result;
		} catch (error) {
			await db
				.query('ROLLBACK')
				.catch((rollbackError) => console.error({ tag: 'DB', msg: `${rollbackContext} rollback failed`, error: String(rollbackError) }));
			throw error;
		}
	});
}

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

const SOURCE_FEED_FIELDS = 'id, name, "RSSLink", url, type, scraped_at, avatar_url';
export type SourceFeedType = 'rss' | 'youtube_channel' | 'twitter_user';

async function getDefaultRssFeeds(db: DbClient): Promise<RSSFeed[]> {
	const result = await db.query<RSSFeed>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE is_default = true AND type = 'rss'`);
	return result.rows;
}

async function getSourceFeedsByType(db: DbClient, type: SourceFeedType): Promise<RSSFeed[]> {
	const result = await db.query<RSSFeed>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE type = $1`, [type]);
	return result.rows;
}

async function markSourceFeedScraped(db: DbClient, feedId: string): Promise<void> {
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feedId]);
}

async function markSourceFeedsScraped(db: DbClient, feedIds: string[]): Promise<void> {
	if (!feedIds.length) return;
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = ANY($2)`, [new Date(), feedIds]);
}

export function listDefaultRssSourceFeeds(env: Env): Promise<RSSFeed[]> {
	return withDbClient(env, getDefaultRssFeeds);
}

export function listSourceFeedsByType(env: Env, type: SourceFeedType): Promise<RSSFeed[]> {
	return withDbClient(env, (db) => getSourceFeedsByType(db, type));
}

export function markSourceFeedScrapedById(env: Env, feedId: string): Promise<void> {
	return withDbClient(env, (db) => markSourceFeedScraped(db, feedId));
}

export function markSourceFeedsScrapedByIds(env: Env, feedIds: string[]): Promise<void> {
	return withDbClient(env, (db) => markSourceFeedsScraped(db, feedIds));
}

// ─────────────────────────────────────────────────────────────
// Article insert helpers
// ─────────────────────────────────────────────────────────────

export interface InsertArticleData {
	url: string;
	title: string;
	source: string;
	publishedDate: Date | string;
	summary: string;
	sourceType: string;
	content: string | null;
	ogImageUrl: string | null;
	/** Plain object — helper stringifies before insert. Pass `null` to store SQL NULL. */
	platformMetadata: unknown | null;
	keywords?: string[];
	tags?: string[];
}

export interface InsertUserFileData extends Omit<InsertArticleData, 'sourceType'> {
	platformType: 'web' | 'youtube' | 'twitter' | 'hackernews';
	userId: string;
	normalizedUrl?: string;
}

export type InsertUserFileResult = {
	id: string;
	created: boolean;
	title: string;
	title_cn: string | null;
	summary_cn: string | null;
	tags: string[];
	platform_type: string | null;
	og_image_url: string | null;
};

export type ExistingUserFileByUrl = {
	id: string;
	title: string;
	title_cn: string | null;
	summary_cn: string | null;
	tags: string[] | null;
	platform_type: string | null;
	og_image_url: string | null;
	resource_kind: string;
	has_embedding: boolean;
};

const EXISTING_USER_FILE_BY_URL_FIELDS =
	'id, title, title_cn, summary_cn, tags, platform_type, og_image_url, resource_kind, embedding IS NOT NULL AS has_embedding';

function serializeMetadata(metadata: unknown | null): string | null {
	if (metadata === null || metadata === undefined) return null;
	return JSON.stringify(metadata);
}

/**
 * Insert URL-sourced content into the per-user `user_files` table. For blob
 * uploads (PDF/image) the frontend writes `user_files` directly — this helper
 * is only for the scraped-URL path that goes through the Worker scraper.
 *
 * URL rows have:
 *   - resource_kind = url
 *   - origin_type = saved_url
 *   - platform_type = detected platform (`web` | `youtube` | `twitter` | `hackernews`)
 *   - file_type = detected platform for display compatibility
 *   - storage_key / file_size = NULL (no blob)
 *   - source_url = the scraped URL
 *   - extracted_text = scraped markdown content
 *
 * The DB owns URL identity through the partial unique index on
 * (user_id, normalized_source_url) for resource_kind='url'. Callers may dedup
 * for efficiency, but correctness comes from this conflict-safe insert.
 */
export async function insertUserFile(db: DbClient, data: InsertUserFileData): Promise<InsertUserFileResult | null> {
	const normalizedUrl = data.normalizedUrl ?? normalizeUrl(data.url);
	const result = await db.query(
		`WITH inserted AS (
			INSERT INTO ${USER_FILES_TABLE}
			(file_name, file_type, resource_kind, origin_type, platform_type, source_url, normalized_source_url, title, site_name, published_date,
			 summary, extracted_text, og_image_url, keywords, tags, metadata,
			 user_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
			ON CONFLICT (user_id, normalized_source_url)
			WHERE resource_kind = 'url' AND normalized_source_url IS NOT NULL
			DO NOTHING
			RETURNING id, title, title_cn, summary_cn, tags, platform_type, og_image_url, TRUE AS created
		)
		SELECT id, title, title_cn, summary_cn, tags, platform_type, og_image_url, created FROM inserted
		UNION ALL
		SELECT id, title, title_cn, summary_cn, tags, platform_type, og_image_url, FALSE AS created
		FROM ${USER_FILES_TABLE}
		WHERE user_id = $17
		  AND normalized_source_url = $7
		  AND resource_kind = 'url'
		  AND NOT EXISTS (SELECT 1 FROM inserted)
		LIMIT 1`,
		[
			data.title,
			data.platformType,
			'url',
			'saved_url',
			data.platformType,
			data.url,
			normalizedUrl,
			data.title,
			data.source,
			data.publishedDate,
			data.summary,
			data.content,
			data.ogImageUrl,
			data.keywords ?? [],
			data.tags ?? [],
			serializeMetadata(data.platformMetadata),
			data.userId,
		],
	);
	const row = result.rows[0] as InsertUserFileResult | undefined;
	return row ?? null;
}

export async function getUserFileByNormalizedSourceUrl(
	db: DbClient,
	userId: string,
	normalizedUrl: string,
): Promise<ExistingUserFileByUrl | null> {
	const existing = await db.query<ExistingUserFileByUrl>(
		`SELECT ${EXISTING_USER_FILE_BY_URL_FIELDS} FROM ${USER_FILES_TABLE}
		 WHERE user_id = $1
		   AND normalized_source_url = $2
		 LIMIT 1`,
		[userId, normalizedUrl],
	);
	return existing.rows[0] ?? null;
}

/**
 * Insert a blob-backed user_file row. The DB CHECK
 * `user_files_resource_shape_check` requires storage_key + file_size NOT NULL
 * for blob rows.
 *
 *   - originType='upload'     → user-uploaded multipart file (PDF / image)
 *   - originType='saved_url'  → blob URL the worker fetched into R2 (PDF / image link)
 *   - originType='generated'  → AI-generated blob (out of scope here)
 *
 * URL-as-text ingests still go through `insertUserFile` (resource_kind='url').
 */
export interface InsertBlobUserFileData {
	userId: string;
	storageKey: string;
	fileSize: number;
	fileType: string;
	fileName: string;
	originType: 'upload' | 'saved_url' | 'generated';
	title?: string | null;
	/** Set for `saved_url` to enable per-user URL dedup. */
	sourceUrl?: string | null;
	normalizedSourceUrl?: string | null;
	/** PlatformMetadata envelope ({ type, fetchedAt, data, ... }) or null. */
	metadata?: unknown | null;
}

export async function insertBlobUserFile(db: DbClient, data: InsertBlobUserFileData): Promise<{ id: string }> {
	const title = data.title ? data.title.slice(0, 200) : null;
	const result = await db.query(
		`INSERT INTO ${USER_FILES_TABLE}
			(file_name, file_type, file_size, storage_key, resource_kind, origin_type, platform_type,
			 source_url, normalized_source_url, title, metadata, user_id)
		 VALUES ($1, $2, $3, $4, 'blob', $5, NULL, $6, $7, $8, $9, $10)
		 RETURNING id`,
		[
			data.fileName,
			data.fileType,
			data.fileSize,
			data.storageKey,
			data.originType,
			data.sourceUrl ?? null,
			data.normalizedSourceUrl ?? null,
			title,
			serializeMetadata(data.metadata ?? null),
			data.userId,
		],
	);
	const id = result.rows[0]?.id as string | undefined;
	if (!id) throw new Error('insertBlobUserFile returned no id');
	return { id };
}

export async function getUserFileWorkflowInstanceId(db: DbClient, userFileId: string): Promise<string | null> {
	const result = await db.query(
		`SELECT metadata->'workflow'->>'monitor_instance_id' AS instance_id FROM ${USER_FILES_TABLE} WHERE id = $1`,
		[userFileId],
	);
	const row = result.rows[0] as { instance_id?: string | null } | undefined;
	return row?.instance_id ?? null;
}

export async function recordUserFileWorkflowInstanceId(db: DbClient, userFileId: string, instanceId: string): Promise<void> {
	const metadata = JSON.stringify({
		workflow: {
			monitor_instance_id: instanceId,
			monitor_started_at: new Date().toISOString(),
		},
	});
	await db.query(`UPDATE ${USER_FILES_TABLE} SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`, [
		metadata,
		userFileId,
	]);
}

export type ProcessedArticleUpdate = Record<string, unknown>;

// `user_files` carries the same editorial fields as `articles` but with a few
// different column names (content/extracted_text, url/source_url, etc.).
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

// ─────────────────────────────────────────────────────────────
// Dedup helper
// ─────────────────────────────────────────────────────────────

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

/**
 * Return the set of URLs (normalized) that already exist in `table`.
 * Batches the IN clause at `batchSize` to stay within Postgres parameter limits.
 */
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
		`SELECT id FROM ${ARTICLES_TABLE} WHERE scraped_date >= $1 AND (title_cn IS NULL OR summary_cn IS NULL OR embedding IS NULL)`,
		[since],
	);

	const userFileResult = await db.query<{ id: string }>(
		`SELECT id FROM ${USER_FILES_TABLE}
		 WHERE created_at >= $1
		   AND (
		     (resource_kind = 'url' AND (title_cn IS NULL OR summary_cn IS NULL OR embedding IS NULL))
		     OR (
		       resource_kind = 'blob'
		       AND file_type = 'application/pdf'
		       AND (metadata->'extraction'->>'status') IS DISTINCT FROM 'failed'
		       AND (extracted_text IS NULL OR embedding IS NULL)
		     )
		   )`,
		[since],
	);

	return {
		articleIds: [...new Set(articleResult.rows.map((row) => row.id))],
		userFileIds: [...new Set(userFileResult.rows.map((row) => row.id))],
	};
}

// ─────────────────────────────────────────────────────────────
// YouTube transcript upsert
// ─────────────────────────────────────────────────────────────

export interface YoutubeTranscriptRow {
	videoId: string;
	segments: unknown[];
	language: string | null;
	chapters?: unknown;
	chaptersFromDescription?: unknown;
}

export interface YoutubeTranscriptForHighlights {
	transcript: Array<{ startTime: number; endTime: number; text: string }> | null;
	ai_highlights: unknown;
}

export interface YoutubeHighlightsUpdateData {
	videoId: string;
	value: unknown;
	generatedAt: string;
}

export async function upsertYoutubeTranscript(db: DbClient, transcript: YoutubeTranscriptRow): Promise<void> {
	await db.query(
		`INSERT INTO youtube_transcripts (video_id, transcript, language, chapters, chapters_from_description, fetched_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (video_id) DO UPDATE SET
			transcript = EXCLUDED.transcript,
			language = EXCLUDED.language,
			chapters = EXCLUDED.chapters,
			chapters_from_description = EXCLUDED.chapters_from_description,
			fetched_at = EXCLUDED.fetched_at`,
		[
			transcript.videoId,
			JSON.stringify(transcript.segments),
			transcript.language,
			transcript.chapters ? JSON.stringify(transcript.chapters) : null,
			transcript.chaptersFromDescription ?? null,
			new Date(),
		],
	);
}

export async function getYoutubeTranscriptForHighlights(db: DbClient, videoId: string): Promise<YoutubeTranscriptForHighlights | null> {
	const result = await db.query<YoutubeTranscriptForHighlights>(
		'SELECT transcript, ai_highlights FROM youtube_transcripts WHERE video_id = $1',
		[videoId],
	);
	return result.rows[0] ?? null;
}

export async function saveYouTubeHighlights(db: DbClient, update: YoutubeHighlightsUpdateData): Promise<void> {
	await db.query('UPDATE youtube_transcripts SET ai_highlights = $1, highlights_generated_at = $2 WHERE video_id = $3', [
		JSON.stringify(update.value),
		update.generatedAt,
		update.videoId,
	]);
}

// ─────────────────────────────────────────────────────────────
