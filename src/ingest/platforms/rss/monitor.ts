import { getExistingArticlesByUrl } from '@core-shared/article-store';
import type { PlatformMetadata } from '@core-shared/platform-metadata';
import type { RSSFeed } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { startSourceArticleWorkflow } from '@ingest/workflows/queue';
import { XMLParser } from 'fast-xml-parser';
import { Client } from 'pg';
import { resolveDiscussionPlatformMetadata } from '../registry';
import { scrapeWebPage } from '../web-scraper';
import {
	extractImageFromItem,
	extractItemsFromFeed,
	extractRssFullContent,
	extractUrlFromItem,
	type RSSItem,
	stripHtml,
	toPlainText,
} from './parser';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const SOURCE_FEED_FIELDS = 'id, name, "RSSLink", url, type, scraped_at, avatar_url';

type FeedItemWithUrl = { item: RSSItem; url: string };

async function queueRssItem(env: Env, feed: RSSFeed, item: RSSItem, url: string): Promise<boolean> {
	let sourceType = 'rss';
	let platformMetadata: PlatformMetadata | null = null;
	const commentsUrl = toPlainText(item.comments) || undefined;
	if (commentsUrl) {
		try {
			platformMetadata = await resolveDiscussionPlatformMetadata(commentsUrl);
			sourceType = platformMetadata?.type ?? sourceType;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Failed to resolve discussion metadata', feed: feed.name, error: String(err) });
		}
	}

	let crawledContent = '';
	let fetchedOgImageUrl: string | null = null;
	let ogImageWidth: number | null = null;
	let ogImageHeight: number | null = null;
	if (sourceType === 'rss') {
		const rssContent = extractRssFullContent(item);
		if (rssContent) {
			crawledContent = rssContent;
		} else {
			try {
				const scraped = await scrapeWebPage(url);
				crawledContent = scraped.content;
				fetchedOgImageUrl = scraped.ogImageUrl;
				ogImageWidth = scraped.ogImageWidth ?? null;
				ogImageHeight = scraped.ogImageHeight ?? null;
			} catch (e) {
				console.warn({ tag: 'RSS', msg: 'Scrape fallback failed', url, error: String(e) });
			}
		}
	}

	const pubDate = toPlainText(item.pubDate) || toPlainText(item.isoDate) || toPlainText(item.published) || toPlainText(item.updated);
	const metadataToStore = platformMetadata ? { ...platformMetadata, ogImageWidth, ogImageHeight } : null;

	await startSourceArticleWorkflow(env, {
		article: {
			url,
			title: toPlainText(item.title) || toPlainText(item.text) || 'No Title',
			source: feed.name,
			publishedDate: pubDate ? new Date(pubDate) : new Date(),
			summary: platformMetadata ? '' : stripHtml(item.description ?? item.summary ?? ''),
			sourceType,
			content: crawledContent || null,
			ogImageUrl: fetchedOgImageUrl ?? extractImageFromItem(item),
			platformMetadata: metadataToStore,
		},
	});
	return true;
}

async function processFeed(env: Env, db: Client, feed: RSSFeed, parser: XMLParser): Promise<void> {
	let res: Response;
	try {
		res = await fetchWithTimeout(feed.RSSLink, {
			headers: {
				'User-Agent': FEED_UA,
				Accept: 'application/rss+xml, application/xml, text/xml, */*',
			},
		});
	} catch (err) {
		return console.warn({ tag: 'RSS', msg: 'Feed fetch failed', feed: feed.name, error: String(err) });
	}
	if (!res.ok) return console.warn({ tag: 'RSS', msg: 'Feed fetch failed', feed: feed.name, status: res.status });

	let items = extractItemsFromFeed(parser.parse(await readTextWithLimit(res, MAX_FEED_BYTES)));
	if (!items.length) {
		console.info({ tag: 'RSS', msg: 'Feed has no items', feed: feed.name });
		await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
		return;
	}

	if (items.length > 30) items = items.slice(0, 30);

	const itemUrls: FeedItemWithUrl[] = [];
	for (const item of items) {
		const rawUrl = extractUrlFromItem(item);
		if (rawUrl) itemUrls.push({ item, url: normalizeUrl(rawUrl) });
	}
	const urls = itemUrls.map(({ url }) => url);
	const existingRecords = await getExistingArticlesByUrl(db, urls);
	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, totalCount: items.length });
	let queued = 0;
	for (const { item, url } of newItems) {
		try {
			if (await queueRssItem(env, feed, item, url)) queued++;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Item enqueue failed, skipping', feed: feed.name, url, error: String(err) });
		}
	}
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
}

export async function handleRSSCron(env: Env): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const parser = new XMLParser({ ignoreAttributes: false });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const feeds = (await db.query<RSSFeed>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE is_default = true AND type = 'rss'`)).rows;
	for (const feed of feeds) {
		try {
			await processFeed(env, db, feed, parser);
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Feed failed', feed: feed.name, error: String(err) });
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
