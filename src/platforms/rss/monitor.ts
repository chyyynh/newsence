import { XMLParser } from 'fast-xml-parser';
import type { Client } from 'pg';
import { fanOutToSubscribers, getSourceSubscribers, getSubscribedSources } from '../../domain/distribute';
import { type FeedConfig, getFeedConfig } from './feed-config';
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
import { detectPlatformType, extractHackerNewsId, HN_ALGOLIA_API, scrapeWebPage } from '../../domain/scrapers';
import { ARTICLES_TABLE, createDbClient } from '../../infra/db';
import { logError, logInfo, logWarn } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import type { PlatformMetadata } from '../../models/platform-metadata';
import { buildHackerNews } from '../../models/platform-metadata';
import type { Env, ExecutionContext, RSSFeed } from '../../models/types';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

async function fetchHnPlatformMetadata(commentsUrl: string): Promise<(PlatformMetadata & { type: 'hackernews' }) | null> {
	if (detectPlatformType(commentsUrl) !== 'hackernews') return null;
	const hnItemId = extractHackerNewsId(commentsUrl);
	if (!hnItemId) return null;
	const res = await fetch(`${HN_ALGOLIA_API}/${hnItemId}`);
	if (!res.ok) return null;
	const hn = (await res.json()) as {
		id: number;
		author?: string;
		points?: number;
		descendants?: number;
		type?: string;
	};
	return buildHackerNews({
		itemId: hn.id.toString(),
		author: hn.author ?? '',
		points: hn.points ?? 0,
		commentCount: hn.descendants ?? 0,
		itemType: (hn.type as 'story' | 'ask' | 'show' | 'job') ?? 'story',
		storyUrl: commentsUrl,
	});
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function processAndInsertArticle(db: Client, env: Env, item: RSSItem, feed: RSSFeed, config: FeedConfig): Promise<void> {
	const rawUrl = extractUrlFromItem(item);
	const url = rawUrl ? normalizeUrl(rawUrl) : null;
	if (!url) return;

	let platformMetadata: PlatformMetadata | null = null;
	let sourceType = 'rss';
	let crawledContent = '';
	let ogImageUrl: string | null = null;
	let ogImageWidth: number | null = null;
	let ogImageHeight: number | null = null;
	// Determine source type from the RSS item's comments URL
	const commentsUrl = item.comments as string | undefined;
	if (commentsUrl) {
		try {
			const hnMeta = await fetchHnPlatformMetadata(commentsUrl);
			if (hnMeta) {
				sourceType = 'hackernews';
				platformMetadata = hnMeta;
			}
		} catch (err) {
			logWarn('RSS', 'Failed to fetch HN metadata', {
				feed: feed.name,
				error: String(err),
			});
		}
	}

	// Fetch content based on feed config
	if (sourceType === 'rss') {
		switch (config.contentSource) {
			case 'content_encoded': {
				const rssContent = extractRssFullContent(item);
				if (rssContent) crawledContent = rssContent;
				break;
			}
			case 'description': {
				const raw = toPlainText(item.description);
				if (raw && raw.length > 100) crawledContent = htmlToMarkdown(raw);
				break;
			}
			case 'scrape': {
				const rssContent = extractRssFullContent(item);
				if (rssContent) {
					crawledContent = rssContent;
				} else {
					try {
						const scraped = await scrapeWebPage(url);
						crawledContent = scraped.content;
						if (!ogImageUrl) {
							ogImageUrl = scraped.ogImageUrl;
							ogImageWidth = scraped.ogImageWidth ?? null;
							ogImageHeight = scraped.ogImageHeight ?? null;
						}
					} catch (e) {
						logWarn('RSS', 'Scrape fallback failed', { url, error: String(e) });
					}
				}
				break;
			}
			case 'skip':
				break;
		}
	}

	// Extract image from RSS item metadata (zero-cost, no HTTP request)
	if (!ogImageUrl) {
		ogImageUrl = extractImageFromItem(item);
	}

	const pubDate = item.pubDate ?? item.isoDate ?? item.published ?? item.updated;
	const content = crawledContent || null;

	const table = ARTICLES_TABLE;
	const publishedDate = pubDate ? new Date(pubDate) : new Date();
	const scrapedDate = new Date();
	const title = item.title ?? item.text ?? 'No Title';
	const source = feed.name ?? 'Unknown';
	const summary = sourceType === 'hackernews' || config.summarySource === 'ai' ? '' : stripHtml(item.description ?? item.summary ?? '');

	const result = await db.query(
		`INSERT INTO ${table} (url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 RETURNING id`,
		[
			url,
			title,
			source,
			publishedDate,
			scrapedDate,
			[],
			[],
			[],
			summary,
			sourceType,
			content,
			ogImageUrl,
			platformMetadata
				? JSON.stringify({ ...platformMetadata, ogImageWidth, ogImageHeight })
				: ogImageWidth && ogImageHeight
					? JSON.stringify({
							type: 'default',
							fetchedAt: new Date().toISOString(),
							data: null,
							ogImageWidth,
							ogImageHeight,
						})
					: null,
		],
	);

	if (result.rows.length === 0)
		return logError('RSS', 'Insert error', {
			feed: feed.name,
			error: 'No rows returned',
		});

	const articleId = result.rows[0]?.id;
	if (articleId) {
		await env.ARTICLE_QUEUE.send({
			type: 'article_process',
			article_id: articleId,
			source_type: sourceType,
		});
	}
}

async function processFeed(db: Client, env: Env, feed: RSSFeed, parser: XMLParser): Promise<void> {
	if (feed.type !== 'rss') return;

	const res = await fetch(feed.RSSLink, {
		headers: {
			'User-Agent': USER_AGENT,
			Accept: 'application/rss+xml, application/xml, text/xml, */*',
		},
	});
	if (!res.ok)
		return logWarn('RSS', 'Feed fetch failed', {
			feed: feed.name,
			status: res.status,
		});

	let items = extractItemsFromFeed(parser.parse(await res.text()));
	if (!items.length) return;

	const config = getFeedConfig(feed.name);

	if (items.length > 30) items = items.slice(0, 30);

	// Filter existing URLs
	const urls = items
		.map((item) => extractUrlFromItem(item))
		.filter(Boolean)
		.map((u) => normalizeUrl(u!));
	const table = ARTICLES_TABLE;
	const dedupBatchSize = 50;
	const existingRecords: Array<{ url: string; source: string; source_type: string }> = [];

	for (let i = 0; i < urls.length; i += dedupBatchSize) {
		const batch = urls.slice(i, i + dedupBatchSize);
		const result = await db.query(`SELECT url, source, source_type FROM ${table} WHERE url = ANY($1)`, [batch]);
		existingRecords.push(...(result.rows as Array<{ url: string; source: string; source_type: string }>));
	}

	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = items.filter((item) => {
		const url = extractUrlFromItem(item);
		return url && !existingSet.has(normalizeUrl(url));
	});

	// Upgrade source to this feed when a duplicate exists from a lower-priority source
	// e.g., a tweet already saved by Twitter cron gets upgraded to "Hacker News" when HN links to it
	const SOURCE_PRIORITY: Record<string, number> = {
		Unknown: 0,
		Telegram: 1,
	};
	const TYPE_PRIORITY: Record<string, number> = { twitter: 0 };
	const feedPriority = SOURCE_PRIORITY[feed.name] ?? 10; // RSS feeds default to high priority

	// Build URL→item map for fetching comments URL during upgrade
	const urlToItem = new Map<string, RSSItem>();
	for (const item of items) {
		const url = extractUrlFromItem(item);
		if (url) urlToItem.set(normalizeUrl(url), item);
	}

	for (const existing of existingRecords) {
		const existingPriority = SOURCE_PRIORITY[existing.source] ?? TYPE_PRIORITY[existing.source_type] ?? 10;
		if (feedPriority > existingPriority) {
			const normalized = normalizeUrl(existing.url);
			const updateFields: string[] = ['source = $1'];
			const updateValues: unknown[] = [feed.name];
			let paramIndex = 2;

			// Fetch platform metadata from the RSS item's comments URL (e.g., HN discussion)
			const rssItem = urlToItem.get(normalized);
			const commentsUrl = rssItem?.comments as string | undefined;
			if (commentsUrl) {
				try {
					const hnMeta = await fetchHnPlatformMetadata(commentsUrl);
					if (hnMeta) {
						updateFields.push(`source_type = $${paramIndex}`);
						updateValues.push('hackernews');
						paramIndex++;
						updateFields.push(`platform_metadata = $${paramIndex}`);
						updateValues.push(JSON.stringify(hnMeta));
						paramIndex++;
					}
				} catch (err) {
					logWarn('RSS', 'Failed to fetch HN metadata for upgrade', {
						url: normalized,
						error: String(err),
					});
				}
			}

			updateValues.push(normalized);
			await db.query(`UPDATE ${table} SET ${updateFields.join(', ')} WHERE url = $${paramIndex}`, updateValues);
			logInfo('RSS', 'Upgraded article source', {
				url: normalized,
				from: existing.source,
				to: feed.name,
			});
		}
	}

	logInfo('RSS', 'Feed processed', {
		feed: feed.name,
		newCount: newItems.length,
		totalCount: items.length,
	});
	let inserted = 0;
	for (const item of newItems) {
		try {
			await processAndInsertArticle(db, env, item, feed, config);
			inserted++;
		} catch (err) {
			logWarn('RSS', 'Item insert failed, skipping', {
				feed: feed.name,
				url: extractUrlFromItem(item),
				error: String(err),
			});
		}
	}
	logInfo('RSS', 'Feed insert done', {
		feed: feed.name,
		inserted,
		total: newItems.length,
	});
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
}

// ─────────────────────────────────────────────────────────────
// Subscription Pass — processes non-default sources with subscribers
// Fetches each feed once, then fans out articles to each subscriber's user_articles
// ─────────────────────────────────────────────────────────────

async function processSubscribedFeeds(db: Client, env: Env, parser: XMLParser, sourceType: string): Promise<void> {
	const feeds = await getSubscribedSources(db, sourceType);
	if (!feeds.length) return;

	logInfo('RSS-SUB', 'Processing subscribed feeds', { count: feeds.length });
	for (const feed of feeds) {
		if (!feed.RSSLink || feed.type !== 'rss') continue;
		try {
			const res = await fetch(feed.RSSLink, {
				headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
			});
			if (!res.ok) {
				logWarn('RSS-SUB', 'Feed fetch failed', { feed: feed.name, status: res.status });
				continue;
			}

			const items = extractItemsFromFeed(parser.parse(await res.text())).slice(0, 30);
			if (!items.length) continue;

			const subscribers = await getSourceSubscribers(db, feed.id);
			if (!subscribers.length) continue;

			const config = getFeedConfig(feed.name);
			let inserted = 0;
			for (const item of items) {
				const rawUrl = extractUrlFromItem(item);
				if (!rawUrl) continue;
				const url = normalizeUrl(rawUrl);

				const pubDate = item.pubDate ?? item.isoDate ?? item.published ?? item.updated;
				const title = item.title ?? item.text ?? 'No Title';
				const summary = config.summarySource === 'ai' ? '' : stripHtml(item.description ?? item.summary ?? '');
				let content = '';
				if (config.contentSource === 'content_encoded') content = extractRssFullContent(item) || '';
				else if (config.contentSource === 'description') content = htmlToMarkdown(toPlainText(item.description) || '');
				const ogImageUrl = extractImageFromItem(item) || null;

				await fanOutToSubscribers(
					db,
					env,
					{
						url,
						title,
						source: feed.name,
						publishedDate: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
						summary,
						sourceType: 'rss',
						content: content || null,
						ogImageUrl,
						platformMetadata: null,
					},
					subscribers,
					feed.id,
				);
				inserted++;
			}
			await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
			logInfo('RSS-SUB', 'Feed done', { feed: feed.name, items: inserted, subscribers: subscribers.length });
		} catch (err) {
			logWarn('RSS-SUB', 'Feed failed', { feed: feed.name, error: String(err) });
		}
	}
}

export async function handleRSSCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('RSS', 'start');
	const db = await createDbClient(env);
	try {
		const parser = new XMLParser({ ignoreAttributes: false });

		// Pass 1: default sources → articles table
		const defaultResult = await db.query(`SELECT id, name, "RSSLink", url, type FROM "RssList" WHERE is_default = true AND type = 'rss'`);
		const feeds = defaultResult.rows as RSSFeed[];
		const FEED_CONCURRENCY = 5;
		for (let i = 0; i < feeds.length; i += FEED_CONCURRENCY) {
			const batch = feeds.slice(i, i + FEED_CONCURRENCY);
			const results = await Promise.allSettled(batch.map((feed: RSSFeed) => processFeed(db, env, feed, parser)));
			for (let j = 0; j < results.length; j++) {
				if (results[j].status === 'rejected') {
					logWarn('RSS', 'Feed failed', {
						feed: batch[j].name,
						error: String((results[j] as PromiseRejectedResult).reason),
					});
				}
			}
		}

		// Pass 2: subscribed non-default sources → user_articles (fan-out per subscriber)
		await processSubscribedFeeds(db, env, parser, 'rss');

		logInfo('RSS', 'end');
	} finally {
		await db.end();
	}
}
