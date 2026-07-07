import { getExistingArticlesByUrl } from '@core-shared/article-store';
import type { PlatformMetadata } from '@core-shared/platform-metadata';
import type { RSSFeed } from '@core-shared/types';
import { decodeHtmlEntities, FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { startSourceArticleWorkflow } from '@ingest/workflows/queue';
import { Client } from 'pg';
import { resolveDiscussionPlatformMetadata } from '../registry';
import { scrapeWebPage } from '../web-scraper';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const SOURCE_FEED_FIELDS = 'id, name, "RSSLink", url, type, scraped_at, avatar_url';

type RSSItem = FeedEntry & {
	comments?: unknown;
	rawContent?: unknown;
};
type FeedItemWithUrl = { item: RSSItem; url: string };

function toPlainText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return value.map(toPlainText).filter(Boolean).join(' ');
	if (typeof value === 'object') return Object.values(value).map(toPlainText).filter(Boolean).join(' ');
	return '';
}

function htmlToMarkdown(html: string): string {
	const markdown = html
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
		.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n')
		.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n')
		.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n')
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
		.replace(/<\/?[ou]l[^>]*>/gi, '\n')
		.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
		.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
		.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
		.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
		.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
		.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, '^($1)')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
		.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) =>
			content
				.trim()
				.split('\n')
				.map((line: string) => `> ${line}`)
				.join('\n'),
		)
		.replace(/<[^>]*>/g, '');
	return decodeHtmlEntities(markdown)
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function extractRssFullContent(item: RSSItem): string {
	const raw = toPlainText(item.rawContent) || item.description || '';
	if (!raw || raw.length < 800) return '';
	return htmlToMarkdown(raw);
}

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
	if (sourceType === 'rss') {
		const rssContent = extractRssFullContent(item);
		if (rssContent) {
			crawledContent = rssContent;
		} else {
			try {
				const scraped = await scrapeWebPage(url);
				crawledContent = scraped.content;
			} catch (e) {
				console.warn({ tag: 'RSS', msg: 'Scrape fallback failed', url, error: String(e) });
			}
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
			content: crawledContent || null,
			ogImageUrl: null,
			platformMetadata,
		},
	});
	return true;
}

function parseFeedItems(xml: string): RSSItem[] {
	return (extractFromXml(xml, {
		descriptionMaxLen: 0,
		getExtraEntryFields: (entry) => ({
			comments: entry.comments,
			rawContent: entry['content:encoded'] ?? entry.content ?? entry.description ?? entry.summary,
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

	let items = parseFeedItems(await readTextWithLimit(res, MAX_FEED_BYTES));
	if (!items.length) {
		console.info({ tag: 'RSS', msg: 'Feed has no items', feed: feed.name });
		await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
		return;
	}

	if (items.length > 30) items = items.slice(0, 30);

	const itemUrls: FeedItemWithUrl[] = [];
	for (const item of items) {
		const rawUrl = item.link;
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
