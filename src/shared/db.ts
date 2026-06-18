import { Client } from 'pg';
import type { Env } from './types';
import { normalizeUrl, validateImageUrl } from './web';
export type DbClient = Client;

export async function createDbClient(env: Env): Promise<Client> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return client;
}

export const ARTICLES_TABLE = 'articles';
export const USER_FILES_TABLE = 'user_files';
export type ProcessableTable = typeof ARTICLES_TABLE | typeof USER_FILES_TABLE;

export function resolveProcessableTable(table?: string | null): ProcessableTable {
	if (!table) return ARTICLES_TABLE;
	if (table === ARTICLES_TABLE || table === USER_FILES_TABLE) return table;
	throw new Error(`Unsupported workflow target table: ${table}`);
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

function serializeMetadata(metadata: unknown | null): string | null {
	if (metadata === null || metadata === undefined) return null;
	return JSON.stringify(metadata);
}

/**
 * Insert into the shared `articles` table. Uses ON CONFLICT (url) DO NOTHING
 * so concurrent monitors can't race on the same URL. Returns null when the
 * row already existed.
 *
 * `og_image_url` is stored as the raw upstream URL — the frontend wraps it
 * through the signed `/media/external/` URL at the API boundary
 * (frontend/src/lib/r2/sign-article-media.ts), so secret rotation doesn't
 * require a DB backfill.
 */
export async function insertArticle(db: DbClient, data: InsertArticleData): Promise<string | null> {
	const ogImageUrl = await validateImageUrl(data.ogImageUrl);
	const result = await db.query(
		`INSERT INTO ${ARTICLES_TABLE}
			(url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (url) DO NOTHING
		RETURNING id`,
		[
			data.url,
			data.title,
			data.source,
			data.publishedDate,
			new Date(),
			data.keywords ?? [],
			data.tags ?? [],
			[],
			data.summary,
			data.sourceType,
			data.content,
			ogImageUrl,
			serializeMetadata(data.platformMetadata),
		],
	);
	return (result.rows[0]?.id as string | undefined) ?? null;
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
	const ogImageUrl = await validateImageUrl(data.ogImageUrl);
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
			ogImageUrl,
			data.keywords ?? [],
			data.tags ?? [],
			serializeMetadata(data.platformMetadata),
			data.userId,
		],
	);
	const row = result.rows[0] as InsertUserFileResult | undefined;
	return row ?? null;
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

// ─────────────────────────────────────────────────────────────
// Dedup helper
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Queue enqueue helper
// ─────────────────────────────────────────────────────────────

/** Enqueue an article for the AI-processing workflow. */
export async function enqueueArticleProcess(env: Env, articleId: string, targetTable?: ProcessableTable): Promise<void> {
	await env.ARTICLE_QUEUE.send({
		type: 'article_process',
		article_id: articleId,
		...(targetTable ? { target_table: targetTable } : {}),
	});
}

export async function createUserFileWorkflow(env: Env, userFileId: string): Promise<string | undefined> {
	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			params: { article_id: userFileId, target_table: USER_FILES_TABLE },
		});
		return instance.id;
	} catch (err) {
		console.error({ tag: 'WORKFLOW', msg: 'create failed', userFileId, error: String(err) });
		return undefined;
	}
}
