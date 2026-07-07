import { getExistingArticlesByUrl } from '@core-shared/article-store';
import type { PlatformMetadata } from '@core-shared/platform-metadata';
import type { RSSFeed } from '@core-shared/types';
import { detectUrlKind, extractHackerNewsId, FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { startSourceArticleWorkflow } from '@ingest/workflows/queue';
import { Client } from 'pg';
import { buildHnMetadata, fetchHnItem } from '../hackernews/scraper';
import { scrapeWebPage } from '../web-scraper';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const SOURCE_FEED_FIELDS = 'id, name, "RSSLink", url, type, scraped_at, avatar_url';

type RSSItem = FeedEntry & {
	comments?: unknown;
};

async function queueRssItem(env: Env, feed: RSSFeed, item: RSSItem, url: string): Promise<void> {
	let sourceType = 'rss';
	let platformMetadata: PlatformMetadata | null = null;
	const commentsUrl = typeof item.comments === 'string' ? item.comments.trim() : undefined;
	const hnItemId = commentsUrl && detectUrlKind(commentsUrl) === 'hackernews' ? extractHackerNewsId(commentsUrl) : null;
	if (hnItemId) {
		try {
			const hnItem = await fetchHnItem(hnItemId);
			platformMetadata = { type: 'hackernews', fetchedAt: new Date().toISOString(), data: buildHnMetadata(hnItem, commentsUrl) };
			sourceType = 'hackernews';
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Failed to resolve discussion metadata', feed: feed.name, error: String(err) });
		}
	}

	let crawledContent: string | null = null;
	if (sourceType === 'rss') {
		try {
			crawledContent = (await scrapeWebPage(url)).content;
		} catch (e) {
			console.warn({ tag: 'RSS', msg: 'Article scrape failed, continuing with feed summary', url, error: String(e) });
		}
	}

	const pubDate = item.published ?? '';

	await startSourceArticleWorkflow(env, {
		article: {
			url,
			title: item.title || 'No Title',
			source: feed.name,
			publishedDate: pubDate ? new Date(pubDate) : new Date(),
			summary: platformMetadata ? '' : (item.description ?? ''),
			sourceType,
			content: crawledContent,
			ogImageUrl: null,
			platformMetadata,
		},
	});
}

function parseFeedItems(xml: string): RSSItem[] {
	return (extractFromXml(xml, {
		descriptionMaxLen: 0,
		getExtraEntryFields: (entry) => ({
			comments: entry.comments,
		}),
	}).entries ?? []) as RSSItem[];
}

async function processFeed(env: Env, db: Client, feed: RSSFeed): Promise<void> {
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

	const items = parseFeedItems(await readTextWithLimit(res, MAX_FEED_BYTES)).slice(0, 30);
	if (!items.length) {
		console.info({ tag: 'RSS', msg: 'Feed has no items', feed: feed.name });
		await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
		return;
	}

	const itemUrls = items.flatMap((item) => (item.link ? [{ item, url: normalizeUrl(item.link) }] : []));
	const urls = itemUrls.map(({ url }) => url);
	const existingRecords = await getExistingArticlesByUrl(db, urls);
	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, totalCount: items.length });
	let queued = 0;
	for (const { item, url } of newItems) {
		try {
			await queueRssItem(env, feed, item, url);
			queued++;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Item enqueue failed, skipping', feed: feed.name, url, error: String(err) });
		}
	}
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
}

export async function handleRSSCron(env: Env): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const feeds = (await db.query<RSSFeed>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE is_default = true AND type = 'rss'`)).rows;
	for (const feed of feeds) {
		try {
			await processFeed(env, db, feed);
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Feed failed', feed: feed.name, error: String(err) });
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
