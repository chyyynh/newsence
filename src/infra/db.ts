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
export const USER_ARTICLES_TABLE = 'user_articles';

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
 * Insert into the per-user `user_articles` table. Same shape as
 * `insertArticle` plus the user_id / visibility columns. No `tokens` column.
 */
export async function insertUserArticle(
	db: DbClient,
	data: InsertArticleData & { userId: string; visibility?: 'public' | 'private' },
): Promise<string | null> {
	const result = await db.query(
		`INSERT INTO ${USER_ARTICLES_TABLE}
			(url, title, source, published_date, scraped_date, summary, source_type, content, og_image_url, keywords, tags, platform_metadata, user_id, visibility)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
		ON CONFLICT DO NOTHING
		RETURNING id`,
		[
			data.url,
			data.title,
			data.source,
			data.publishedDate,
			new Date(),
			data.summary,
			data.sourceType,
			data.content,
			data.ogImageUrl,
			data.keywords ?? [],
			data.tags ?? [],
			serializeMetadata(data.platformMetadata),
			data.userId,
			data.visibility ?? 'public',
		],
	);
	return (result.rows[0]?.id as string | undefined) ?? null;
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
