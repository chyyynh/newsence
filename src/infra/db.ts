import { Client } from 'pg';
import type { Env } from '../models/types';
import { normalizeUrl } from './web';
export type DbClient = Client;

export async function createDbClient(env: Env): Promise<Client> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return client;
}

export const ARTICLES_TABLE = 'articles';
export const USER_FILES_TABLE = 'user_files';

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
	visibility?: 'public' | 'private';
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
 */
export async function insertArticle(db: DbClient, data: InsertArticleData): Promise<string | null> {
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
			data.ogImageUrl,
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
	const result = await db.query(
		`WITH inserted AS (
			INSERT INTO ${USER_FILES_TABLE}
			(file_name, file_type, resource_kind, origin_type, platform_type, source_url, normalized_source_url, title, site_name, published_date,
			 summary, extracted_text, og_image_url, keywords, tags, metadata,
			 user_id, visibility)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
			data.visibility ?? 'private',
		],
	);
	const row = result.rows[0] as InsertUserFileResult | undefined;
	return row ?? null;
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
export async function enqueueArticleProcess(env: Env, articleId: string, sourceType: string, targetTable?: string): Promise<void> {
	await env.ARTICLE_QUEUE.send({
		type: 'article_process',
		article_id: articleId,
		source_type: sourceType,
		...(targetTable ? { target_table: targetTable } : {}),
	});
}
