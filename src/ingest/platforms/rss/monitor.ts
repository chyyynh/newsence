import { ARTICLES_TABLE, createDbClient, enqueueArticleProcess, insertArticle } from '@shared/db';
import type { PlatformMetadata } from '@shared/platform-metadata';
import type { Env, ExecutionContext, RSSFeed } from '@shared/types';
import { detectPlatformType, extractHackerNewsId, FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@shared/web';
import { XMLParser } from 'fast-xml-parser';
import type { Client } from 'pg';
import { buildHnPlatformMetadata, fetchHnItem } from '../hackernews/scraper';
import { scrapeWebPage } from '../web/scraper';
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

async function processAndInsertArticle(db: Client, env: Env, item: RSSItem, url: string, feed: RSSFeed, config: FeedConfig): Promise<void> {
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

	const articleId = await insertArticle(db, {
		url,
		title,
		source,
		publishedDate,
		summary,
		sourceType,
		content,
		ogImageUrl,
		platformMetadata: metadataToStore,
	});

	if (!articleId) {
		return console.info({ tag: 'RSS', msg: 'Insert skipped (duplicate URL)', feed: feed.name, url });
	}

	await enqueueArticleProcess(env, articleId);
}

// Source priorities for the upgrade-on-duplicate flow: RSS feeds default to 10
// and overwrite anything below them. Lower number = lower priority.
const SOURCE_PRIORITY: Record<string, number> = { Unknown: 0 };
const TYPE_PRIORITY: Record<string, number> = { twitter: 0 };
const DEFAULT_FEED_PRIORITY = 10;
const MAX_FEED_BYTES = 3 * 1024 * 1024;

type ExistingRecord = { url: string; source: string; source_type: string };
type FeedItemWithUrl = { item: RSSItem; url: string };

function extractFeedItemUrls(items: RSSItem[]): FeedItemWithUrl[] {
	const entries: FeedItemWithUrl[] = [];
	for (const item of items) {
		const rawUrl = extractUrlFromItem(item);
		if (rawUrl) entries.push({ item, url: normalizeUrl(rawUrl) });
	}
	return entries;
}

async function fetchExistingRecords(db: Client, urls: string[]): Promise<ExistingRecord[]> {
	const dedupBatchSize = 50;
	const out: ExistingRecord[] = [];
	for (let i = 0; i < urls.length; i += dedupBatchSize) {
		const batch = urls.slice(i, i + dedupBatchSize);
		const result = await db.query(`SELECT url, source, source_type FROM ${ARTICLES_TABLE} WHERE url = ANY($1)`, [batch]);
		out.push(...(result.rows as ExistingRecord[]));
	}
	return out;
}

/** Upgrade a single existing article's source/metadata when this feed outranks it. */
async function upgradeExistingArticleSource(
	db: Client,
	feed: RSSFeed,
	feedPriority: number,
	existing: ExistingRecord,
	rssItem: RSSItem | undefined,
): Promise<void> {
	const existingPriority = SOURCE_PRIORITY[existing.source] ?? TYPE_PRIORITY[existing.source_type] ?? DEFAULT_FEED_PRIORITY;
	if (feedPriority <= existingPriority) return;

	const normalized = normalizeUrl(existing.url);
	const updateFields: string[] = ['source = $1'];
	const updateValues: unknown[] = [feed.name];
	let paramIndex = 2;

	const commentsUrl = rssItem ? toPlainText(rssItem.comments) || undefined : undefined;
	if (commentsUrl) {
		try {
			const hnMeta = await fetchHnPlatformMetadata(commentsUrl);
			if (hnMeta) {
				updateFields.push(`source_type = $${paramIndex++}`);
				updateValues.push('hackernews');
				updateFields.push(`platform_metadata = $${paramIndex++}`);
				updateValues.push(JSON.stringify(hnMeta));
			}
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Failed to fetch HN metadata for upgrade', url: normalized, error: String(err) });
		}
	}

	updateValues.push(normalized);
	await db.query(`UPDATE ${ARTICLES_TABLE} SET ${updateFields.join(', ')} WHERE url = $${paramIndex}`, updateValues);
	console.info({ tag: 'RSS', msg: 'Upgraded article source', url: normalized, from: existing.source, to: feed.name });
}

async function processFeed(db: Client, env: Env, feed: RSSFeed, parser: XMLParser): Promise<void> {
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
	if (!items.length) return;

	const config = getFeedConfig(feed.name);
	if (items.length > 30) items = items.slice(0, 30);

	const itemUrls = extractFeedItemUrls(items);
	const urls = itemUrls.map(({ url }) => url);
	const existingRecords = await fetchExistingRecords(db, urls);
	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));

	const urlToItem = new Map<string, RSSItem>();
	for (const { item, url } of itemUrls) {
		urlToItem.set(url, item);
	}

	const feedPriority = SOURCE_PRIORITY[feed.name] ?? DEFAULT_FEED_PRIORITY;
	for (const existing of existingRecords) {
		await upgradeExistingArticleSource(db, feed, feedPriority, existing, urlToItem.get(normalizeUrl(existing.url)));
	}

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, totalCount: items.length });
	let inserted = 0;
	for (const { item, url } of newItems) {
		try {
			await processAndInsertArticle(db, env, item, url, feed, config);
			inserted++;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Item insert failed, skipping', feed: feed.name, url, error: String(err) });
		}
	}
	console.info({ tag: 'RSS', msg: 'Feed insert done', feed: feed.name, inserted, total: newItems.length });
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
}

export async function handleRSSCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const db = await createDbClient(env);
	try {
		const parser = new XMLParser({ ignoreAttributes: false });

		// Pass 1: default sources → articles table
		const defaultResult = await db.query(`SELECT id, name, "RSSLink", url, type FROM "RssList" WHERE is_default = true AND type = 'rss'`);
		const feeds = defaultResult.rows as RSSFeed[];
		for (const feed of feeds) {
			try {
				await processFeed(db, env, feed, parser);
			} catch (err) {
				console.warn({ tag: 'RSS', msg: 'Feed failed', feed: feed.name, error: String(err) });
			}
		}

		console.info({ tag: 'RSS', msg: 'end' });
	} finally {
		await db.end();
	}
}
