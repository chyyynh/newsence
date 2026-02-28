import { XMLParser } from 'fast-xml-parser';
import { type FeedConfig, getFeedConfig } from '../domain/feed-config';
import { scrapeTwitterArticle, scrapeWebPage } from '../domain/scrapers';
import { assessContent } from '../infra/ai';
import { getArticlesTable, getSupabaseClient } from '../infra/db';
import { logError, logInfo, logWarn } from '../infra/log';
import { fetchPlatformMetadata } from '../infra/platform';
import { isSocialMediaUrl, normalizeUrl, resolveUrl } from '../infra/web';
import type { TwitterMedia } from '../models/platform-metadata';
import { buildHackerNews, buildTwitterArticle, buildTwitterShared, buildTwitterStandard } from '../models/platform-metadata';
import { extractHackerNewsId, HN_ALGOLIA_API } from '../domain/scrapers';
import type { Env, ExecutionContext, RSSFeed, Tweet } from '../models/types';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

type RSSItem = Record<string, any>;

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

async function processAndInsertArticle(supabase: any, env: Env, item: RSSItem, feed: RSSFeed, config: FeedConfig): Promise<void> {
	const rawUrl = extractUrlFromItem(item);
	const url = rawUrl ? normalizeUrl(rawUrl) : null;
	if (!url) return;

	let platformMetadata = null;
	let sourceType = 'rss';
	let crawledContent = '';
	let ogImageUrl: string | null = null;
	let enrichedSummary: string | null = null;

	// Fetch platform metadata
	try {
		const result = await fetchPlatformMetadata(url, env.YOUTUBE_API_KEY, item.comments ?? null, env.KAITO_API_KEY);
		platformMetadata = result.platformMetadata;
		sourceType = result.sourceType;

		if (platformMetadata?.data) {
			if (platformMetadata.type === 'youtube') {
				ogImageUrl = platformMetadata.data.thumbnailUrl || null;
				const desc = platformMetadata.data.description;
				if (desc && desc.length > 50) enrichedSummary = desc.slice(0, 500);
			} else if (platformMetadata.type === 'twitter') {
				const media = 'media' in platformMetadata.data ? platformMetadata.data.media : undefined;
				if (media?.length) ogImageUrl = media[0].url;
			}
		}
	} catch (err) {
		logWarn('RSS', 'Metadata fetch failed', { feed: feed.name, error: String(err) });
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
	const content = sourceType === 'youtube' ? null : crawledContent || null;

	const insert = {
		url,
		title: item.title ?? item.text ?? 'No Title',
		source: feed.name ?? 'Unknown',
		published_date: pubDate ? new Date(pubDate) : new Date(),
		scraped_date: new Date(),
		keywords: [],
		tags: [],
		tokens: [],
		summary:
			enrichedSummary ??
			(sourceType === 'hackernews' || config.summarySource === 'ai' ? '' : stripHtml(item.description ?? item.summary ?? '')),
		source_type: sourceType,
		content,
		og_image_url: ogImageUrl,
		...(platformMetadata && { platform_metadata: platformMetadata }),
	};

	const table = getArticlesTable(env);
	const { data: inserted, error } = await supabase.from(table).insert([insert]).select('id');
	if (error) return logError('RSS', 'Insert error', { feed: feed.name, error: String(error) });

	const articleId = inserted?.[0]?.id;
	if (articleId) {
		await env.ARTICLE_QUEUE.send({
			type: 'article_process',
			article_id: articleId,
			source_type: insert.source_type,
		});
	}
}

async function processFeed(supabase: any, env: Env, feed: RSSFeed, parser: XMLParser): Promise<void> {
	if (feed.type !== 'rss') return;

	const res = await fetch(feed.RSSLink, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
	});
	if (!res.ok) return logWarn('RSS', 'Feed fetch failed', { feed: feed.name, status: res.status });

	let items = extractItemsFromFeed(parser.parse(await res.text()));
	if (!items.length) return;

	const config = getFeedConfig(feed.name);

	if (items.length > 30) items = items.slice(0, 30);

	// Filter existing URLs
	const urls = items
		.map((item) => extractUrlFromItem(item))
		.filter(Boolean)
		.map((u) => normalizeUrl(u!));
	const table = getArticlesTable(env);
	const dedupBatchSize = 50;
	const existingRecords: Array<{ url: string; source: string }> = [];

	for (let i = 0; i < urls.length; i += dedupBatchSize) {
		const { data } = await supabase
			.from(table)
			.select('url, source')
			.in('url', urls.slice(i, i + dedupBatchSize));
		if (data) existingRecords.push(...(data as Array<{ url: string; source: string }>));
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
			const update: Record<string, unknown> = { source: feed.name };

			// Fetch platform metadata from the RSS item's comments URL (e.g., HN discussion)
			const rssItem = urlToItem.get(normalized);
			const commentsUrl = rssItem?.comments as string | undefined;
			if (commentsUrl) {
				const hnItemId = extractHackerNewsId(commentsUrl);
				if (hnItemId) {
					try {
						const res = await fetch(`${HN_ALGOLIA_API}/${hnItemId}`);
						if (res.ok) {
							const hn = (await res.json()) as { id: number; author?: string; points?: number; descendants?: number; type?: string };
							update.source_type = 'hackernews';
							update.platform_metadata = buildHackerNews({
								itemId: hn.id.toString(),
								author: hn.author ?? '',
								points: hn.points ?? 0,
								commentCount: hn.descendants ?? 0,
								itemType: (hn.type as 'story' | 'ask' | 'show' | 'job') ?? 'story',
								storyUrl: commentsUrl,
							});
						}
					} catch (err) {
						logWarn('RSS', 'Failed to fetch HN metadata for upgrade', { url: normalized, error: String(err) });
					}
				}
			}

			await supabase.from(table).update(update).eq('url', normalized);
			logInfo('RSS', 'Upgraded article source', { url: normalized, from: existing.source, to: feed.name });
		}
	}

	logInfo('RSS', 'Feed processed', { feed: feed.name, newCount: newItems.length, totalCount: items.length });
	for (const item of newItems) await processAndInsertArticle(supabase, env, item, feed, config);
	await supabase.from('RssList').update({ scraped_at: new Date() }).eq('id', feed.id);
}

export async function handleRSSCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('RSS', 'start');
	const supabase = getSupabaseClient(env);
	const parser = new XMLParser({ ignoreAttributes: false });
	const { data: feeds, error } = await supabase.from('RssList').select('id, name, RSSLink, url, type');
	if (error) return logError('RSS', 'Fetch feeds failed', { error: String(error) });
	await Promise.allSettled((feeds ?? []).map((feed: RSSFeed) => processFeed(supabase, env, feed, parser)));
	logInfo('RSS', 'end');
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

async function getLastTwitterTime(supabase: any, env: Env): Promise<Date> {
	const { data } = await supabase
		.from(getArticlesTable(env))
		.select('scraped_date')
		.eq('source_type', 'twitter')
		.order('scraped_date', { ascending: false })
		.limit(1)
		.single();
	return data ? new Date(data.scraped_date) : new Date(Date.now() - 24 * 60 * 60 * 1000);
}

async function saveScrapedArticle(
	supabase: any,
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
	const table = getArticlesTable(env);

	const articleData = {
		url: data.url,
		title: data.title,
		source: data.source,
		published_date: data.createdAt ? new Date(data.createdAt) : new Date(),
		scraped_date: new Date(),
		keywords: [],
		tags: [],
		tokens: [],
		summary: '',
		source_type: data.sourceType,
		content: data.content,
		og_image_url: data.ogImage,
		platform_metadata: buildTwitterShared(
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
		),
	};

	const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');

	if (error) {
		logError('TWITTER', 'Insert scraped article error', { error: String(error) });
		return false;
	}

	const articleId = inserted?.[0]?.id;
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
async function checkDuplicateByContent(supabase: any, table: string, urls: string[]): Promise<boolean> {
	const normalized = urls.map(normalizeUrl).filter(Boolean);
	if (normalized.length === 0) return false;
	const { data } = await supabase.from(table).select('id').in('url', normalized).limit(1);
	return (data?.length ?? 0) > 0;
}

async function saveTweet(tweet: Tweet, supabase: any, env: Env): Promise<boolean> {
	const table = getArticlesTable(env);
	const tweetUrl = normalizeUrl(tweet.url);

	// Check for duplicates
	const { data: existing } = await supabase.from(table).select('id').eq('url', tweetUrl).single();
	if (existing) return false;

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
				const articleData = {
					url: tweetUrl,
					title: articleContent.title,
					source: 'Twitter',
					published_date: articleContent.publishedDate ? new Date(articleContent.publishedDate) : new Date(),
					scraped_date: new Date(),
					keywords: [],
					tags: [],
					tokens: [],
					summary: articleContent.summary || '',
					source_type: 'twitter',
					content: articleContent.content,
					og_image_url: articleContent.ogImageUrl || null,
					platform_metadata: buildTwitterArticle(
						{
							authorName: meta?.authorName || tweet.author?.name || '',
							authorUserName: meta?.authorUserName || tweet.author?.userName || '',
							authorProfilePicture: meta?.authorProfilePicture || (tweet.author as any)?.profilePicture,
							authorVerified: meta?.authorVerified ?? tweet.author?.verified,
						},
						tweetId,
					),
				};

				const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');
				if (error) {
					logError('TWITTER', 'Insert article error', { error: String(error) });
					return false;
				}

				const articleId = inserted?.[0]?.id;
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
		if (await checkDuplicateByContent(supabase, table, [resolvedUrl])) {
			logInfo('TWITTER', 'Link already exists (dedup)', { url: resolvedUrl });
			return false;
		}

		// Scrape link content
		const scraped = await scrapeWebPage(resolvedUrl);

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

		return saveScrapedArticle(supabase, env, {
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
	if (externalUrl && (await checkDuplicateByContent(supabase, table, [externalUrl]))) {
		logInfo('TWITTER', 'External URL already exists (dedup)', { url: externalUrl });
		return false;
	}

	// Fetch external link's og:image, title, and content
	let externalOgImage: string | null = null;
	let externalTitle: string | null = null;
	let externalContent: string | null = null;
	if (externalUrl) {
		try {
			const scraped = await scrapeWebPage(externalUrl);
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

	const articleData = {
		url: tweetUrl,
		title: `@${tweet.author?.userName}: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? '...' : ''}`,
		source: 'Twitter',
		published_date: new Date(tweet.createdAt),
		scraped_date: new Date(),
		keywords: tweet.hashTags || [],
		tags: [],
		tokens: [],
		summary: tweet.text,
		source_type: 'twitter',
		content: externalContent,
		og_image_url: tweetMedia[0]?.url ?? externalOgImage ?? null,
		platform_metadata: tweetPlatformMetadata,
	};

	const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');
	if (error) {
		logError('TWITTER', 'Insert error', { error: String(error) });
		return false;
	}

	const articleId = inserted?.[0]?.id;
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

async function fetchHighViewTweets(apiKey: string, listId: string, supabase: any, env: Env): Promise<number> {
	const lastTime = await getLastTwitterTime(supabase, env);
	const sinceTime = Math.floor((lastTime.getTime() - 60 * 60 * 1000) / 1000);
	let cursor: string | null = null;
	let count = 0;

	while (true) {
		const params = new URLSearchParams({ listId, sinceTime: sinceTime.toString(), includeReplies: 'false', limit: '20' });
		if (cursor) params.append('cursor', cursor);

		const res = await fetch(`${TWITTER_API}?${params}`, {
			headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
		});
		if (!res.ok) break;

		const data: TwitterApiResponse = await res.json();
		if (data.status !== 'success') break;

		for (const tweet of data.tweets || []) {
			if (tweet.viewCount > VIEW_THRESHOLD && (await saveTweet(tweet, supabase, env))) count++;
		}

		if (!data.has_next_page) break;
		cursor = data.next_cursor || null;
		await new Promise((r) => setTimeout(r, 1000));
	}

	return count;
}

export async function handleTwitterCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('TWITTER', 'start');
	const supabase = getSupabaseClient(env);
	const results = await Promise.all(TWITTER_LISTS.map((listId) => fetchHighViewTweets(env.KAITO_API_KEY || '', listId, supabase, env)));
	logInfo('TWITTER', 'end', { inserted: results.reduce((a, b) => a + b, 0) });
}

// ─────────────────────────────────────────────────────────────
// Retry Failed Articles
// ─────────────────────────────────────────────────────────────

const RETRY_BATCH_SIZE = 20;

export async function handleRetryCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	logInfo('RETRY', 'start');
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);
	const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

	// AI processing failures
	const { data: aiIncomplete, error } = await supabase
		.from(table)
		.select('id')
		.gte('scraped_date', since)
		.or('title_cn.is.null,summary_cn.is.null,embedding.is.null');

	if (error) return logError('RETRY', 'Query failed', { error: String(error) });

	// Translation failures (content exists but content_cn is null)
	const { data: translationIncomplete } = await supabase
		.from(table)
		.select('id')
		.gte('scraped_date', since)
		.not('content', 'is', null)
		.is('content_cn', null);

	const ids = [
		...new Set([
			...(aiIncomplete ?? []).map((r: { id: string }) => r.id),
			...(translationIncomplete ?? []).map((r: { id: string }) => r.id),
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
}
