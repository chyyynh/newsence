import { XMLParser } from 'fast-xml-parser';
import type { Client } from 'pg';
import { type FeedConfig, getFeedConfig } from '../domain/feed-config';
import { detectPlatformType, extractHackerNewsId, HN_ALGOLIA_API, scrapeTwitterArticle, scrapeWebPage } from '../domain/scrapers';
import { assessContent } from '../infra/ai';
import { ARTICLES_TABLE, createDbClient } from '../infra/db';
import { logError, logInfo, logWarn } from '../infra/log';
import { isSocialMediaUrl, normalizeUrl, resolveUrl } from '../infra/web';
import type { PlatformMetadata, TwitterMedia } from '../models/platform-metadata';
import { buildHackerNews, buildTwitterArticle, buildTwitterShared, buildTwitterStandard } from '../models/platform-metadata';
import type { Env, ExecutionContext, RSSFeed, Tweet } from '../models/types';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

type RSSItem = Record<string, any>;

async function fetchHnPlatformMetadata(commentsUrl: string): Promise<(PlatformMetadata & { type: 'hackernews' }) | null> {
	if (detectPlatformType(commentsUrl) !== 'hackernews') return null;
	const hnItemId = extractHackerNewsId(commentsUrl);
	if (!hnItemId) return null;
	const res = await fetch(`${HN_ALGOLIA_API}/${hnItemId}`);
	if (!res.ok) return null;
	const hn = (await res.json()) as { id: number; author?: string; points?: number; descendants?: number; type?: string };
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

function toPlainText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		return value.map(toPlainText).filter(Boolean).join(' ');
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const preferredKeys = ['#text', '_text', 'text', 'value', 'content', 'summary', 'description'];
		for (const key of preferredKeys) {
			const text = toPlainText(record[key]);
			if (text) return text;
		}
		return Object.values(record).map(toPlainText).filter(Boolean).join(' ');
	}
	return '';
}

export function stripHtml(raw: unknown): string {
	const text = toPlainText(raw);
	if (!text) return '';
	return text
		.replace(/<[^>]*>/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ')
		.trim();
}

export function extractRssFullContent(item: RSSItem): string {
	// content:encoded (RSS 2.0) → content (Atom) → description (Discourse forums put full HTML here)
	const raw = toPlainText(item['content:encoded']) || toPlainText(item.content) || toPlainText(item.description);
	if (!raw || raw.length < 800) return '';
	// Convert HTML to Markdown preserving structure
	return htmlToMarkdown(raw);
}

export function htmlToMarkdown(html: string): string {
	return (
		html
			// Block elements
			.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
			.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
			.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
			.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n')
			.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n')
			.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n')
			// Lists
			.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
			.replace(/<\/?[ou]l[^>]*>/gi, '\n')
			// Inline elements
			.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
			.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
			.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
			.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
			.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
			.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, '^($1)')
			// Block breaks
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
			// Strip remaining tags
			.replace(/<[^>]*>/g, '')
			// HTML entities
			.replace(/&quot;/g, '"')
			.replace(/&#x27;|&#39;/g, "'")
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&nbsp;/g, ' ')
			// Clean up whitespace
			.replace(/\n{3,}/g, '\n\n')
			.trim()
	);
}

export function extractUrlFromItem(item: RSSItem): string | null {
	if (typeof item.link === 'string') return item.link;
	return item.link?.['@_href'] ?? item.link?.href ?? item.url ?? null;
}

export function extractItemsFromFeed(data: any): RSSItem[] {
	const source = data?.rss?.channel?.item ?? data?.feed?.entry ?? data?.channel?.item ?? data?.['rdf:RDF']?.item;
	return source ? (Array.isArray(source) ? source : [source]) : [];
}

async function processAndInsertArticle(db: Client, env: Env, item: RSSItem, feed: RSSFeed, config: FeedConfig): Promise<void> {
	const rawUrl = extractUrlFromItem(item);
	const url = rawUrl ? normalizeUrl(rawUrl) : null;
	if (!url) return;

	let platformMetadata: PlatformMetadata | null = null;
	let sourceType = 'rss';
	let crawledContent = '';
	let ogImageUrl: string | null = null;
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
			logWarn('RSS', 'Failed to fetch HN metadata', { feed: feed.name, error: String(err) });
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
						const scraped = await scrapeWebPage(url, env);
						crawledContent = scraped.content;
						if (!ogImageUrl) ogImageUrl = scraped.ogImageUrl;
					} catch {}
				}
				break;
			}
			case 'skip':
				break;
		}
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
			platformMetadata ? JSON.stringify(platformMetadata) : null,
		],
	);

	if (result.rows.length === 0) return logError('RSS', 'Insert error', { feed: feed.name, error: 'No rows returned' });

	const articleId = result.rows[0]?.id;
	if (articleId) {
		await env.ARTICLE_QUEUE.send({
			type: 'article_process',
			article_id: articleId,
			source_type: sourceType,
		});
	}
}

async function processFeed(env: Env, feed: RSSFeed, parser: XMLParser): Promise<void> {
	if (feed.type !== 'rss') return;

	const res = await fetch(feed.RSSLink, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
	});
	if (!res.ok) return logWarn('RSS', 'Feed fetch failed', { feed: feed.name, status: res.status });

	let items = extractItemsFromFeed(parser.parse(await res.text()));
	if (!items.length) return;

	const config = getFeedConfig(feed.name);

	if (items.length > 30) items = items.slice(0, 30);

	// Each feed gets its own Client — Hyperdrive pools the underlying connections
	const db = await createDbClient(env);
	try {
		// Filter existing URLs
		const urls = items
			.map((item) => extractUrlFromItem(item))
			.filter(Boolean)
			.map((u) => normalizeUrl(u!));
		const table = ARTICLES_TABLE;
		const dedupBatchSize = 50;
		const existingRecords: Array<{ url: string; source: string }> = [];

		for (let i = 0; i < urls.length; i += dedupBatchSize) {
			const batch = urls.slice(i, i + dedupBatchSize);
			const result = await db.query(`SELECT url, source FROM ${table} WHERE url = ANY($1)`, [batch]);
			existingRecords.push(...(result.rows as Array<{ url: string; source: string }>));
		}

		const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
		const newItems = items.filter((item) => {
			const url = extractUrlFromItem(item);
			return url && !existingSet.has(normalizeUrl(url));
		});

		// Upgrade source to this feed when a duplicate exists from a lower-priority source
		// e.g., a tweet already saved by Twitter cron gets upgraded to "Hacker News" when HN links to it
		const SOURCE_PRIORITY: Record<string, number> = { Twitter: 0, Unknown: 0, Telegram: 1 };
		const feedPriority = SOURCE_PRIORITY[feed.name] ?? 10; // RSS feeds default to high priority

		// Build URL→item map for fetching comments URL during upgrade
		const urlToItem = new Map<string, RSSItem>();
		for (const item of items) {
			const url = extractUrlFromItem(item);
			if (url) urlToItem.set(normalizeUrl(url), item);
		}

		for (const existing of existingRecords) {
			const existingPriority = SOURCE_PRIORITY[existing.source] ?? 10;
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
						logWarn('RSS', 'Failed to fetch HN metadata for upgrade', { url: normalized, error: String(err) });
					}
				}

				updateValues.push(normalized);
				await db.query(`UPDATE ${table} SET ${updateFields.join(', ')} WHERE url = $${paramIndex}`, updateValues);
				logInfo('RSS', 'Upgraded article source', { url: normalized, from: existing.source, to: feed.name });
			}
		}

		logInfo('RSS', 'Feed processed', { feed: feed.name, newCount: newItems.length, totalCount: items.length });
		for (const item of newItems) {
			try {
				await processAndInsertArticle(db, env, item, feed, config);
			} catch (err) {
				logError('RSS', 'processAndInsertArticle failed', {
					feed: feed.name,
					url: extractUrlFromItem(item),
					error: String(err),
				});
			}
		}
		await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
	} finally {
		await db.end();
	}
}

const RSS_CONCURRENCY = 5;

async function runWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
	let i = 0;
	const next = async (): Promise<void> => {
		while (i < items.length) {
			const item = items[i++]!;
			await fn(item);
		}
	};
	await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
}

export async function handleRSSCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('RSS', 'start');
	const db = await createDbClient(env);
	try {
		const parser = new XMLParser({ ignoreAttributes: false });
		const result = await db.query(`SELECT id, name, "RSSLink", url, type FROM "RssList"`);
		const feeds = result.rows as RSSFeed[];
		// Each processFeed creates its own Client (Hyperdrive pools underneath).
		// Limit to RSS_CONCURRENCY parallel feeds to cap backend connections.
		await runWithConcurrency(feeds, RSS_CONCURRENCY, async (feed: RSSFeed) => {
			try {
				await processFeed(env, feed, parser);
			} catch (err) {
				logError('RSS', 'Feed failed', { feed: feed.name, error: String(err) });
			}
		});
		logInfo('RSS', 'end');
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Twitter Monitor
// ─────────────────────────────────────────────────────────────

interface TwitterApiResponse {
	status: string;
	message?: string;
	tweets?: Tweet[];
	has_next_page?: boolean;
	next_cursor?: string;
}

const TWITTER_API = 'https://api.twitterapi.io/twitter/list/tweets';
const VIEW_THRESHOLD = 10000;
const TWITTER_LISTS = ['1894659296388157547', '1920007527703662678'];

async function getLastTwitterTime(db: Client, env: Env): Promise<Date> {
	const table = ARTICLES_TABLE;
	const result = await db.query(`SELECT scraped_date FROM ${table} WHERE source_type = $1 ORDER BY scraped_date DESC LIMIT 1`, ['twitter']);
	return result.rows[0] ? new Date(result.rows[0].scraped_date) : new Date(Date.now() - 24 * 60 * 60 * 1000);
}

async function saveScrapedArticle(
	db: Client,
	env: Env,
	data: {
		url: string;
		title: string;
		content: string;
		source: string;
		sourceType: string;
		ogImage: string | null;
		originalTweetUrl?: string;
		tweetText?: string;
		authorName?: string;
		authorUserName?: string;
		authorProfilePicture?: string;
		authorVerified?: boolean;
		media?: TwitterMedia[];
		createdAt?: string;
	},
): Promise<boolean> {
	const table = ARTICLES_TABLE;

	const platformMetadata = buildTwitterShared(
		{
			authorName: data.authorName || '',
			authorUserName: data.authorUserName || '',
			authorProfilePicture: data.authorProfilePicture,
			authorVerified: data.authorVerified,
		},
		{
			media: data.media || [],
			createdAt: data.createdAt,
			tweetText: data.tweetText,
			externalUrl: data.url,
			externalOgImage: data.ogImage,
			externalTitle: data.title,
			originalTweetUrl: data.originalTweetUrl,
		},
	);

	const result = await db.query(
		`INSERT INTO ${table} (url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 RETURNING id`,
		[
			data.url,
			data.title,
			data.source,
			data.createdAt ? new Date(data.createdAt) : new Date(),
			new Date(),
			[],
			[],
			[],
			'',
			data.sourceType,
			data.content,
			data.ogImage,
			JSON.stringify(platformMetadata),
		],
	);

	if (result.rows.length === 0) {
		logError('TWITTER', 'Insert scraped article error', { error: 'No rows returned' });
		return false;
	}

	const articleId = result.rows[0]?.id;
	if (articleId) {
		await env.ARTICLE_QUEUE.send({
			type: 'article_process',
			article_id: articleId,
			source_type: data.sourceType,
		});
	}

	logInfo('TWITTER', 'Saved scraped article', { title: data.title.slice(0, 50) });
	return true;
}

function extractTweetMedia(tweet: Tweet): TwitterMedia[] {
	return (
		tweet.extendedEntities?.media?.flatMap((m) =>
			m.media_url_https ? [{ url: m.media_url_https, type: m.type as TwitterMedia['type'] }] : [],
		) ?? []
	);
}

/** Check if any of the given URLs already exist as article.url in the DB */
async function checkDuplicateByContent(db: Client, table: string, urls: string[]): Promise<boolean> {
	const normalized = urls.map(normalizeUrl).filter(Boolean);
	if (normalized.length === 0) return false;
	const result = await db.query(`SELECT id FROM ${table} WHERE url = ANY($1) LIMIT 1`, [normalized]);
	return result.rows.length > 0;
}

async function saveTweet(tweet: Tweet, db: Client, env: Env): Promise<boolean> {
	const table = ARTICLES_TABLE;
	const tweetUrl = normalizeUrl(tweet.url);

	// Check for duplicates
	const existingResult = await db.query(`SELECT id FROM ${table} WHERE url = $1 LIMIT 1`, [tweetUrl]);
	if (existingResult.rows.length > 0) return false;

	// Check for Twitter Article via expanded URLs
	const expandedUrls = (tweet.urls || []).map((u: any) => u.expanded_url || u.url || u).filter(Boolean) as string[];
	const articleUrl = expandedUrls.find((u) => /(?:twitter\.com|x\.com)\/i\/article\//.test(u));

	if (articleUrl) {
		const tweetId = tweet.id || tweet.url.split('/').pop();
		if (tweetId) {
			logInfo('TWITTER', 'Detected Twitter Article', { tweetId, articleUrl });
			const articleContent = await scrapeTwitterArticle(tweetId, env.KAITO_API_KEY || '');
			if (articleContent) {
				const meta = articleContent.metadata as Record<string, any> | undefined;

				const twitterArticleMeta = buildTwitterArticle(
					{
						authorName: meta?.authorName || tweet.author?.name || '',
						authorUserName: meta?.authorUserName || tweet.author?.userName || '',
						authorProfilePicture: meta?.authorProfilePicture || (tweet.author as any)?.profilePicture,
						authorVerified: meta?.authorVerified ?? tweet.author?.verified,
					},
					tweetId,
				);

				const result = await db.query(
					`INSERT INTO ${table} (url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
					 RETURNING id`,
					[
						tweetUrl,
						articleContent.title,
						'Twitter',
						articleContent.publishedDate ? new Date(articleContent.publishedDate) : new Date(),
						new Date(),
						[],
						[],
						[],
						articleContent.summary || '',
						'twitter',
						articleContent.content,
						articleContent.ogImageUrl || null,
						JSON.stringify(twitterArticleMeta),
					],
				);

				if (result.rows.length === 0) {
					logError('TWITTER', 'Insert article error', { error: 'No rows returned' });
					return false;
				}

				const articleId = result.rows[0]?.id;
				if (articleId) {
					await env.ARTICLE_QUEUE.send({ type: 'article_process', article_id: articleId, source_type: 'twitter' });
				}
				logInfo('TWITTER', 'Saved Twitter Article', { title: articleContent.title.slice(0, 50) });
				return true;
			}
			logWarn('TWITTER', 'Article API failed, falling through to regular tweet handling');
		}
	}

	// Extract links and text without URLs
	const links = tweet.text.match(/https?:\/\/\S+/g) || [];
	const textWithoutUrls = tweet.text.replace(/https?:\/\/\S+/g, '').trim();

	// AI Assessment
	const assessment = await assessContent(
		{
			title: `@${tweet.author?.userName}`,
			text: textWithoutUrls,
			url: tweet.url,
			source: 'Twitter',
			sourceType: 'twitter',
			links,
			metrics: {
				viewCount: tweet.viewCount,
				likeCount: tweet.likeCount,
			},
		},
		env.OPENROUTER_API_KEY,
	);

	// Handle based on assessment
	if (assessment.action === 'discard') {
		logInfo('TWITTER', 'Filtered tweet', { author: tweet.author?.userName, reason: assessment.reason });
		return false;
	}

	if (assessment.action === 'follow_link' && links.length > 0) {
		// Resolve and scrape link content
		const resolvedUrl = await resolveUrl(links[0]!);

		// Skip social media links
		if (isSocialMediaUrl(resolvedUrl)) {
			logInfo('TWITTER', 'Skipped social media link', { url: resolvedUrl });
			return false;
		}

		// Cross-source dedup: check if resolved URL or normalized form already exists
		if (await checkDuplicateByContent(db, table, [resolvedUrl])) {
			logInfo('TWITTER', 'Link already exists (dedup)', { url: resolvedUrl });
			return false;
		}

		// Scrape link content
		let scraped;
		try {
			scraped = await scrapeWebPage(resolvedUrl, env);
		} catch (err) {
			logWarn('TWITTER', 'Failed to scrape followed link', { url: resolvedUrl, error: String(err) });
			return false;
		}

		// Re-assess scraped content
		const scrapedAssessment = await assessContent(
			{
				title: scraped.title || `Shared by @${tweet.author?.userName}`,
				text: scraped.content,
				url: resolvedUrl,
				source: 'Twitter',
				sourceType: 'twitter',
			},
			env.OPENROUTER_API_KEY,
		);

		if (scrapedAssessment.action === 'discard') {
			logInfo('TWITTER', 'Scraped content filtered', { reason: scrapedAssessment.reason });
			return false;
		}

		return saveScrapedArticle(db, env, {
			url: resolvedUrl,
			title: scraped.title || 'Shared Article',
			content: scraped.content,
			source: 'Twitter',
			sourceType: 'twitter',
			ogImage: scraped.ogImageUrl,
			originalTweetUrl: tweet.url,
			tweetText: textWithoutUrls,
			authorName: tweet.author?.name,
			authorUserName: tweet.author?.userName,
			authorProfilePicture: (tweet.author as any)?.profilePicture,
			authorVerified: tweet.author?.verified ?? (tweet.author as any)?.isBlueVerified,
			media: extractTweetMedia(tweet),
			createdAt: tweet.createdAt,
		});
	}

	// assessment.action === 'save' - Save as tweet
	const externalUrl = expandedUrls.find((u) => !/(?:twitter\.com|x\.com|t\.co)/.test(u));

	// Cross-source dedup: if tweet shares an external URL, check if it already exists
	if (externalUrl && (await checkDuplicateByContent(db, table, [externalUrl]))) {
		logInfo('TWITTER', 'External URL already exists (dedup)', { url: externalUrl });
		return false;
	}

	// Fetch external link's og:image, title, and content
	let externalOgImage: string | null = null;
	let externalTitle: string | null = null;
	let externalContent: string | null = null;
	if (externalUrl) {
		try {
			const scraped = await scrapeWebPage(externalUrl, env);
			externalOgImage = scraped.ogImageUrl;
			externalTitle = scraped.title || null;
			if (scraped.content && scraped.content.length > 100) {
				externalContent = scraped.content;
			}
		} catch {
			logWarn('TWITTER', 'Failed to fetch external link metadata', { url: externalUrl });
		}
	}

	const tweetMedia = extractTweetMedia(tweet);

	const tweetAuthor = {
		authorName: tweet.author?.name || '',
		authorUserName: tweet.author?.userName || '',
		authorProfilePicture: (tweet.author as any)?.profilePicture,
		authorVerified: tweet.author?.verified ?? (tweet.author as any)?.isBlueVerified,
	};

	const tweetPlatformMetadata = externalUrl
		? buildTwitterShared(tweetAuthor, {
				media: tweetMedia,
				createdAt: tweet.createdAt,
				tweetText: textWithoutUrls,
				externalUrl,
				externalOgImage,
				externalTitle,
				originalTweetUrl: tweet.url,
			})
		: buildTwitterStandard(tweetAuthor, {
				media: tweetMedia,
				createdAt: tweet.createdAt,
			});

	const result = await db.query(
		`INSERT INTO ${table} (url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 RETURNING id`,
		[
			tweetUrl,
			`@${tweet.author?.userName}: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? '...' : ''}`,
			'Twitter',
			new Date(tweet.createdAt),
			new Date(),
			tweet.hashTags || [],
			[],
			[],
			tweet.text,
			'twitter',
			externalContent,
			tweetMedia[0]?.url ?? externalOgImage ?? null,
			JSON.stringify(tweetPlatformMetadata),
		],
	);

	if (result.rows.length === 0) {
		logError('TWITTER', 'Insert error', { error: 'No rows returned' });
		return false;
	}

	const articleId = result.rows[0]?.id;
	if (articleId) {
		await env.ARTICLE_QUEUE.send({
			type: 'article_process',
			article_id: articleId,
			source_type: 'twitter',
		});
	}

	logInfo('TWITTER', 'Saved tweet', { author: tweet.author?.userName, score: assessment.score });
	return true;
}

async function fetchHighViewTweets(apiKey: string, listId: string, db: Client, env: Env): Promise<number> {
	const lastTime = await getLastTwitterTime(db, env);
	const sinceTime = Math.floor((lastTime.getTime() - 60 * 60 * 1000) / 1000);
	let cursor: string | null = null;
	let count = 0;

	while (true) {
		const params = new URLSearchParams({ listId, sinceTime: sinceTime.toString(), includeReplies: 'false', limit: '20' });
		if (cursor) params.append('cursor', cursor);

		const res = await fetch(`${TWITTER_API}?${params}`, {
			headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
		});
		if (!res.ok) {
			logError('TWITTER', 'Kaito API HTTP error', { listId, status: res.status, statusText: res.statusText });
			break;
		}

		const data: TwitterApiResponse = await res.json();
		if (data.status !== 'success') {
			logError('TWITTER', 'Kaito API non-success', { listId, status: data.status, message: data.message });
			break;
		}

		for (const tweet of data.tweets || []) {
			try {
				if (tweet.viewCount > VIEW_THRESHOLD && (await saveTweet(tweet, db, env))) count++;
			} catch (err) {
				logError('TWITTER', 'saveTweet failed', { url: tweet.url, author: tweet.author?.userName, error: String(err) });
			}
		}

		if (!data.has_next_page) break;
		cursor = data.next_cursor || null;
		await new Promise((r) => setTimeout(r, 1000));
	}

	return count;
}

export async function handleTwitterCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('TWITTER', 'start');
	// Process lists sequentially — each uses a shared db client, so avoid concurrent queries
	let total = 0;
	for (const listId of TWITTER_LISTS) {
		const db = await createDbClient(env);
		try {
			total += await fetchHighViewTweets(env.KAITO_API_KEY || '', listId, db, env);
		} finally {
			await db.end();
		}
	}
	logInfo('TWITTER', 'end', { inserted: total });
}

// ─────────────────────────────────────────────────────────────
// Retry Failed Articles
// ─────────────────────────────────────────────────────────────

const RETRY_BATCH_SIZE = 20;

export async function handleRetryCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('RETRY', 'start');
	const db = await createDbClient(env);
	try {
		const table = ARTICLES_TABLE;
		const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

		// AI processing failures
		const aiResult = await db.query(
			`SELECT id FROM ${table} WHERE scraped_date >= $1 AND (title_cn IS NULL OR summary_cn IS NULL OR embedding IS NULL)`,
			[since],
		);

		// Translation failures (content exists but content_cn is null)
		const translationResult = await db.query(
			`SELECT id FROM ${table} WHERE scraped_date >= $1 AND content IS NOT NULL AND content_cn IS NULL`,
			[since],
		);

		const ids = [
			...new Set([
				...(aiResult.rows as Array<{ id: string }>).map((r) => r.id),
				...(translationResult.rows as Array<{ id: string }>).map((r) => r.id),
			]),
		];

		if (!ids.length) return logInfo('RETRY', 'No incomplete articles');
		for (let i = 0; i < ids.length; i += RETRY_BATCH_SIZE) {
			await env.ARTICLE_QUEUE.send({
				type: 'batch_process',
				article_ids: ids.slice(i, i + RETRY_BATCH_SIZE),
				triggered_by: 'retry_cron',
			});
		}
		logInfo('RETRY', 'Queued articles for retry', { count: ids.length, batches: Math.ceil(ids.length / RETRY_BATCH_SIZE) });
	} finally {
		await db.end();
	}
}
