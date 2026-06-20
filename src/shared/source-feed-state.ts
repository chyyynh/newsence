import { type DbClient, withDbClient } from './db';
import type { Env, RSSFeed } from './types';

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
