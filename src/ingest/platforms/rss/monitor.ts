import {
	type ArticleSourceUpdate,
	type ExistingArticleRecord,
	getExistingArticlesByUrl,
	updateArticleSourceByUrl,
} from '@shared/article-store';
import { withDbClient } from '@shared/db';
import type { PlatformMetadata } from '@shared/platform-metadata';
import { listDefaultRssSourceFeeds, markSourceFeedScrapedById } from '@shared/source-feed-state';
import type { Env, ExecutionContext, RSSFeed } from '@shared/types';
import { detectPlatformType, extractHackerNewsId, FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@shared/web';
import { startSourceArticleWorkflow } from '@shared/workflow-queue';
import { XMLParser } from 'fast-xml-parser';
import { buildHnPlatformMetadata, fetchHnItem } from '../hackernews/scraper';
import { scrapeWebPage } from '../web-scraper';
import {
	extractImageFromItem,
	extractItemsFromFeed,
	extractRssFullContent,
	extractUrlFromItem,
	htmlToMarkdown,
	type RSSItem,
	stripHtml,
	toPlainText,
} from './parser';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

interface FeedConfig {
	summarySource: 'description' | 'ai';
	contentSource: 'content_encoded' | 'description' | 'scrape' | 'skip';
}

const DEFAULT_CONFIG: FeedConfig = {
	summarySource: 'description',
	contentSource: 'scrape',
};

const FEED_OVERRIDES: Record<string, Partial<FeedConfig>> = {
	'Nvidia Blog': { contentSource: 'content_encoded' },
	'Microsoft Research': { contentSource: 'content_encoded' },
	stratechery: { contentSource: 'content_encoded' },
	Lesswrong: { summarySource: 'ai', contentSource: 'description' },
	'ethresear.ch': { summarySource: 'ai', contentSource: 'description' },
	'Ethereum Magicians': { summarySource: 'ai', contentSource: 'description' },
	'Google Research': { summarySource: 'ai' },
	'Google Deepmind': { summarySource: 'ai' },
	'Anthropic Research': { summarySource: 'ai' },
};

function getFeedConfig(feedName: string): FeedConfig {
	return { ...DEFAULT_CONFIG, ...FEED_OVERRIDES[feedName] };
}

async function fetchHnPlatformMetadata(commentsUrl: string): Promise<(PlatformMetadata & { type: 'hackernews' }) | null> {
	if (detectPlatformType(commentsUrl) !== 'hackernews') return null;
	const hnItemId = extractHackerNewsId(commentsUrl);
	if (!hnItemId) return null;
	const hn = await fetchHnItem(hnItemId);
	return buildHnPlatformMetadata(hn, commentsUrl);
}

interface FetchedRssContent {
	content: string;
	ogImageUrl: string | null;
	ogImageWidth: number | null;
	ogImageHeight: number | null;
}

const EMPTY_CONTENT: FetchedRssContent = { content: '', ogImageUrl: null, ogImageWidth: null, ogImageHeight: null };

async function fetchContentForRssItem(item: RSSItem, config: FeedConfig, url: string): Promise<FetchedRssContent> {
	switch (config.contentSource) {
		case 'content_encoded':
			return { ...EMPTY_CONTENT, content: extractRssFullContent(item) ?? '' };
		case 'description': {
			const raw = toPlainText(item.description);
			return { ...EMPTY_CONTENT, content: raw && raw.length > 100 ? htmlToMarkdown(raw) : '' };
		}
		case 'scrape': {
			const rssContent = extractRssFullContent(item);
			if (rssContent) return { ...EMPTY_CONTENT, content: rssContent };
			try {
				const scraped = await scrapeWebPage(url);
				return {
					content: scraped.content,
					ogImageUrl: scraped.ogImageUrl,
					ogImageWidth: scraped.ogImageWidth ?? null,
					ogImageHeight: scraped.ogImageHeight ?? null,
				};
			} catch (e) {
				console.warn({ tag: 'RSS', msg: 'Scrape fallback failed', url, error: String(e) });
				return EMPTY_CONTENT;
			}
		}
		case 'skip':
			return EMPTY_CONTENT;
	}
}

async function detectHnSource(
	commentsUrl: string | undefined,
	feedName: string,
): Promise<{ sourceType: string; platformMetadata: PlatformMetadata | null }> {
	if (!commentsUrl) return { sourceType: 'rss', platformMetadata: null };
	try {
		const hnMeta = await fetchHnPlatformMetadata(commentsUrl);
		if (hnMeta) return { sourceType: 'hackernews', platformMetadata: hnMeta };
	} catch (err) {
		console.warn({ tag: 'RSS', msg: 'Failed to fetch HN metadata', feed: feedName, error: String(err) });
	}
	return { sourceType: 'rss', platformMetadata: null };
}

async function enqueueRssSourceArticle(env: Env, item: RSSItem, url: string, feed: RSSFeed, config: FeedConfig): Promise<void> {
	const { sourceType, platformMetadata } = await detectHnSource(toPlainText(item.comments) || undefined, feed.name);

	const fetched = sourceType === 'rss' ? await fetchContentForRssItem(item, config, url) : EMPTY_CONTENT;
	const crawledContent = fetched.content;
	const ogImageUrl = fetched.ogImageUrl ?? extractImageFromItem(item);
	const { ogImageWidth, ogImageHeight } = fetched;

	const pubDate = toPlainText(item.pubDate) || toPlainText(item.isoDate) || toPlainText(item.published) || toPlainText(item.updated);
	const content = crawledContent || null;

	const publishedDate = pubDate ? new Date(pubDate) : new Date();
	const title = toPlainText(item.title) || toPlainText(item.text) || 'No Title';
	const source = feed.name ?? 'Unknown';
	const summary = sourceType === 'hackernews' || config.summarySource === 'ai' ? '' : stripHtml(item.description ?? item.summary ?? '');

	const metadataToStore = platformMetadata
		? { ...platformMetadata, ogImageWidth, ogImageHeight }
		: ogImageWidth && ogImageHeight
			? { type: 'default', fetchedAt: new Date().toISOString(), data: null, ogImageWidth, ogImageHeight }
			: null;

	await startSourceArticleWorkflow(env, {
		article: {
			url,
			title,
			source,
			publishedDate,
			summary,
			sourceType,
			content,
			ogImageUrl,
			platformMetadata: metadataToStore,
		},
	});
}

// Source priorities for the upgrade-on-duplicate flow: RSS feeds default to 10
// and overwrite anything below them. Lower number = lower priority.
const SOURCE_PRIORITY: Record<string, number> = { Unknown: 0 };
const TYPE_PRIORITY: Record<string, number> = { twitter: 0 };
const DEFAULT_FEED_PRIORITY = 10;
const MAX_FEED_BYTES = 3 * 1024 * 1024;

type FeedItemWithUrl = { item: RSSItem; url: string };

function extractFeedItemUrls(items: RSSItem[]): FeedItemWithUrl[] {
	const entries: FeedItemWithUrl[] = [];
	for (const item of items) {
		const rawUrl = extractUrlFromItem(item);
		if (rawUrl) entries.push({ item, url: normalizeUrl(rawUrl) });
	}
	return entries;
}

/** Build a source/metadata upgrade for an existing article when this feed outranks it. */
async function prepareExistingArticleSourceUpgrade(
	feed: RSSFeed,
	feedPriority: number,
	existing: ExistingArticleRecord,
	rssItem: RSSItem | undefined,
): Promise<ArticleSourceUpdate | null> {
	const existingPriority = SOURCE_PRIORITY[existing.source] ?? TYPE_PRIORITY[existing.source_type] ?? DEFAULT_FEED_PRIORITY;
	if (feedPriority <= existingPriority) return null;

	const normalized = normalizeUrl(existing.url);
	let sourceType: string | undefined;
	let platformMetadata: PlatformMetadata | undefined;

	const commentsUrl = rssItem ? toPlainText(rssItem.comments) || undefined : undefined;
	if (commentsUrl) {
		try {
			const hnMeta = await fetchHnPlatformMetadata(commentsUrl);
			if (hnMeta) {
				sourceType = 'hackernews';
				platformMetadata = hnMeta;
			}
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Failed to fetch HN metadata for upgrade', url: normalized, error: String(err) });
		}
	}

	return { url: normalized, source: feed.name, sourceType, platformMetadata };
}

async function processFeed(env: Env, feed: RSSFeed, parser: XMLParser): Promise<void> {
	if (feed.type !== 'rss') return;

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
		await markSourceFeedScrapedById(env, feed.id);
		return;
	}

	const config = getFeedConfig(feed.name);
	if (items.length > 30) items = items.slice(0, 30);

	const itemUrls = extractFeedItemUrls(items);
	const urls = itemUrls.map(({ url }) => url);
	const existingRecords = await withDbClient(env, (db) => getExistingArticlesByUrl(db, urls));
	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));

	const urlToItem = new Map<string, RSSItem>();
	for (const { item, url } of itemUrls) {
		urlToItem.set(url, item);
	}

	const feedPriority = SOURCE_PRIORITY[feed.name] ?? DEFAULT_FEED_PRIORITY;
	const sourceUpgrades: Array<{ existing: ExistingArticleRecord; update: ArticleSourceUpdate }> = [];
	for (const existing of existingRecords) {
		const update = await prepareExistingArticleSourceUpgrade(feed, feedPriority, existing, urlToItem.get(normalizeUrl(existing.url)));
		if (update) sourceUpgrades.push({ existing, update });
	}
	if (sourceUpgrades.length) {
		await withDbClient(env, async (db) => {
			for (const { existing, update } of sourceUpgrades) {
				await updateArticleSourceByUrl(db, update);
				console.info({ tag: 'RSS', msg: 'Upgraded article source', url: update.url, from: existing.source, to: feed.name });
			}
		});
	}

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, totalCount: items.length });
	let queued = 0;
	for (const { item, url } of newItems) {
		try {
			await enqueueRssSourceArticle(env, item, url, feed, config);
			queued++;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Item enqueue failed, skipping', feed: feed.name, url, error: String(err) });
		}
	}
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
	await markSourceFeedScrapedById(env, feed.id);
}

export async function handleRSSCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const parser = new XMLParser({ ignoreAttributes: false });
	const feeds = await listDefaultRssSourceFeeds(env);
	for (const feed of feeds) {
		try {
			await processFeed(env, feed, parser);
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Feed failed', feed: feed.name, error: String(err) });
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
