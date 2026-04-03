// ─────────────────────────────────────────────────────────────
// Subscription Distribution — fan-out articles to subscribers
// ─────────────────────────────────────────────────────────────

import type { Client } from 'pg';
import { ARTICLES_TABLE, USER_ARTICLES_TABLE } from '../infra/db';
import { logInfo } from '../infra/log';
import type { Env, RSSFeed } from '../models/types';

export interface Subscriber {
	user_id: string | null;
	organization_id: string | null;
}

export const COPY_ARTICLE_COLS =
	'url, title, title_cn, source, published_date, scraped_date, keywords, tags, summary, summary_cn, source_type, content, content_cn, og_image_url, platform_metadata, embedding';

/** Copy a single article from the global articles table to user_articles for a subscriber. */
export async function copyArticleToUser(
	db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
	articleId: string,
	userId: string | null,
	orgId: string | null,
	rssListId?: string | number | bigint,
): Promise<void> {
	await db.query(
		`INSERT INTO ${USER_ARTICLES_TABLE} (${COPY_ARTICLE_COLS}, user_id, organization_id, visibility, rss_list_id)
		SELECT ${COPY_ARTICLE_COLS}, $2, $3, 'public', $4
		FROM ${ARTICLES_TABLE} WHERE id = $1
		ON CONFLICT DO NOTHING`,
		[articleId, userId, orgId, rssListId ?? null],
	);
}

export async function getSubscribedSources(db: Client, sourceType: string): Promise<RSSFeed[]> {
	const result = await db.query(
		`SELECT DISTINCT r.id, r.name, r."RSSLink", r.url, r.type, r.scraped_at, r.avatar_url
		FROM "RssList" r JOIN feed_sources s ON s.rss_list_id = r.id
		WHERE r.is_default = false AND r.type = $1`,
		[sourceType],
	);
	return result.rows as RSSFeed[];
}

export async function getSourceSubscribers(db: Client, rssListId: string | number | bigint): Promise<Subscriber[]> {
	const result = await db.query(
		`SELECT DISTINCT f.user_id, f.organization_id FROM feed_sources fs JOIN feeds f ON f.id = fs.feed_id WHERE fs.rss_list_id = $1`,
		[rssListId],
	);
	return result.rows as Subscriber[];
}

export async function fanOutToSubscribers(
	db: Client,
	env: Env,
	articleData: {
		url: string;
		title: string;
		source: string;
		publishedDate: string;
		summary: string;
		sourceType: string;
		content: string | null;
		ogImageUrl: string | null;
		platformMetadata: string | null;
	},
	subscribers: Subscriber[],
	rssListId: string | number | bigint,
): Promise<void> {
	if (!subscribers.length) return;

	// Check once if article exists in global articles table
	const existing = await db.query(`SELECT id FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [articleData.url]);
	const globalArticleId = existing.rows[0]?.id as string | undefined;

	if (globalArticleId) {
		// Batch copy from articles → user_articles for all subscribers via feeds JOIN
		await db.query(
			`INSERT INTO ${USER_ARTICLES_TABLE} (${COPY_ARTICLE_COLS}, user_id, organization_id, visibility, rss_list_id)
			SELECT DISTINCT ${COPY_ARTICLE_COLS}, f.user_id, f.organization_id, 'public', fs.rss_list_id
			FROM ${ARTICLES_TABLE} a, feed_sources fs JOIN feeds f ON f.id = fs.feed_id
			WHERE a.id = $1 AND fs.rss_list_id = $2
			ON CONFLICT DO NOTHING`,
			[globalArticleId, rssListId],
		);
		return;
	}

	// New article: insert for the first subscriber, then copy for the rest
	const firstSub = subscribers[0];
	const result = await db.query(
		`INSERT INTO ${USER_ARTICLES_TABLE}
			(url, title, source, published_date, scraped_date, summary, source_type, content, og_image_url, platform_metadata, keywords, tags, user_id, organization_id, visibility, rss_list_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'public', $15)
		ON CONFLICT DO NOTHING RETURNING id`,
		[
			articleData.url,
			articleData.title,
			articleData.source,
			articleData.publishedDate,
			new Date().toISOString(),
			articleData.summary,
			articleData.sourceType,
			articleData.content,
			articleData.ogImageUrl,
			articleData.platformMetadata,
			[],
			[],
			firstSub.user_id,
			firstSub.organization_id,
			rssListId,
		],
	);

	const articleId = result.rows[0]?.id;
	if (articleId) {
		await env.ARTICLE_QUEUE.send({
			type: 'article_process',
			article_id: articleId,
			source_type: articleData.sourceType,
			target_table: USER_ARTICLES_TABLE,
		});
		// Copy to remaining subscribers
		for (const sub of subscribers.slice(1)) {
			await copyArticleToUser(db, articleId as string, sub.user_id, sub.organization_id, rssListId);
		}
	}
}

/**
 * Post-cron distribution: for non-default sources, copy recently inserted articles
 * from the global articles table to each subscriber's user_articles.
 * This lets Twitter/YouTube crons keep their existing logic unchanged.
 */
export async function distributeNonDefaultArticles(db: Client, sourceType: string): Promise<void> {
	const sources = await getSubscribedSources(db, sourceType);
	if (!sources.length) return;

	let copied = 0;
	for (const source of sources) {
		// Batch: cross-join recent articles with subscribers in a single INSERT
		const result = await db.query(
			`INSERT INTO ${USER_ARTICLES_TABLE} (${COPY_ARTICLE_COLS}, user_id, organization_id, visibility, rss_list_id)
			SELECT DISTINCT ${COPY_ARTICLE_COLS}, sub.user_id, sub.organization_id, 'public', sub.rss_list_id
			FROM ${ARTICLES_TABLE} a
			CROSS JOIN (
				SELECT fs.rss_list_id, f.user_id, f.organization_id
				FROM feed_sources fs JOIN feeds f ON f.id = fs.feed_id
				WHERE fs.rss_list_id = $1
			) sub
			WHERE a.source = $2
				AND a.scraped_date > NOW() - INTERVAL '24 hours'
			ON CONFLICT DO NOTHING`,
			[source.id, source.name],
		);
		copied += result.rowCount ?? 0;
	}
	if (copied > 0) logInfo('DISTRIBUTE', `Distributed ${copied} rows for ${sourceType} subscribers`);
}
