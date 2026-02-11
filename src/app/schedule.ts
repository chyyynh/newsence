import { XMLParser } from 'fast-xml-parser';
import { Env, ExecutionContext, Tweet, RSSFeed } from '../models/types';
import { getSupabaseClient, getArticlesTable } from '../infra/db';
import { normalizeUrl, scrapeArticleContent, extractOgImage, resolveUrl, isSocialMediaUrl, extractTitleFromHtml } from '../infra/web';
import { scrapeTwitterArticle } from '../domain/scrapers';
import { fetchPlatformMetadata } from '../infra/platform';
import { assessContent } from '../infra/ai';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

type RSSItem = Record<string, any>;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function stripHtml(raw: string): string {
	return raw
		.replace(/<[^>]*>/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractUrlFromItem(item: RSSItem): string | null {
	if (typeof item.link === 'string') return item.link;
	return item.link?.['@_href'] ?? item.link?.href ?? item.url ?? null;
}

function extractItemsFromFeed(data: any): RSSItem[] {
	const source = data?.rss?.channel?.item ?? data?.feed?.entry ?? data?.channel?.item ?? data?.['rdf:RDF']?.item;
	return source ? (Array.isArray(source) ? source : [source]) : [];
}

async function processAndInsertArticle(supabase: any, env: Env, item: RSSItem, feed: RSSFeed): Promise<void> {
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
			const data = platformMetadata.data as Record<string, unknown>;
			if (platformMetadata.type === 'youtube') {
				ogImageUrl = (data.thumbnailUrl as string) || null;
				const desc = data.description as string;
				if (desc?.length > 50) enrichedSummary = desc.slice(0, 500);
			} else if (platformMetadata.type === 'twitter') {
				const mediaUrls = data.mediaUrls as string[];
				if (mediaUrls?.length) ogImageUrl = mediaUrls[0];
			}
		}
	} catch (err) {
		console.warn(`[${feed.name}] metadata fetch failed:`, err);
	}

	// Scrape content for regular RSS
	if (sourceType === 'rss') {
		try {
			[crawledContent, ogImageUrl] = await Promise.all([
				scrapeArticleContent(url),
				ogImageUrl ? Promise.resolve(ogImageUrl) : extractOgImage(url),
			]);
		} catch {}
	}

	const pubDate = item.pubDate ?? item.isoDate ?? item.published ?? item.updated;
	const content = sourceType === 'youtube'
		? null
		: (crawledContent || null);

	const insert = {
		url,
		title: item.title ?? item.text ?? 'No Title',
		source: feed.name ?? 'Unknown',
		published_date: pubDate ? new Date(pubDate) : new Date(),
		scraped_date: new Date(),
		keywords: [],
		tags: [],
		tokens: [],
		summary: enrichedSummary ?? (sourceType === 'hackernews' ? '' : stripHtml(item.description ?? item.summary ?? '')),
		source_type: sourceType,
		content,
		og_image_url: ogImageUrl,
		...(platformMetadata && { platform_metadata: platformMetadata }),
	};

	const table = getArticlesTable(env);
	const { data: inserted, error } = await supabase.from(table).insert([insert]).select('id');
	if (error) return console.error(`[${feed.name}] insert error:`, error);

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
	if (!res.ok) return console.warn(`[${feed.name}] fetch failed: ${res.status}`);

	let items = extractItemsFromFeed(parser.parse(await res.text()));
	if (!items.length) return;

	// Limit items
	const isAnthropic = feed.name?.toLowerCase().includes('anthropic');
	if (isAnthropic && items.length > 30) items = items.slice(-30);
	else if (items.length > 30) items = items.slice(0, 30);

	// Filter existing URLs
	const urls = items.map((item) => extractUrlFromItem(item)).filter(Boolean).map((u) => normalizeUrl(u!));
	const table = getArticlesTable(env);
	const batchSize = feed.name?.toLowerCase().includes('stratechery') ? 5 : 50;
	const existingUrls: string[] = [];

	for (let i = 0; i < urls.length; i += batchSize) {
		const { data } = await supabase.from(table).select('url').in('url', urls.slice(i, i + batchSize));
		if (data) existingUrls.push(...data.map((e: { url: string }) => normalizeUrl(e.url)));
	}

	const existingSet = new Set(existingUrls);
	const newItems = items.filter((item) => {
		const url = extractUrlFromItem(item);
		return url && !existingSet.has(normalizeUrl(url));
	});

	console.log(`[${feed.name}] ${newItems.length}/${items.length} new`);
	for (const item of newItems) await processAndInsertArticle(supabase, env, item, feed);
	await supabase.from('RssList').update({ scraped_at: new Date() }).eq('id', feed.id);
}

export async function handleRSSCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.log('[RSS] start');
	const supabase = getSupabaseClient(env);
	const parser = new XMLParser({ ignoreAttributes: false });
	const { data: feeds, error } = await supabase.from('RssList').select('id, name, RSSLink, url, type');
	if (error) return console.error('[RSS] fetch feeds failed:', error);
	await Promise.allSettled((feeds ?? []).map((feed: RSSFeed) => processFeed(supabase, env, feed, parser)));
	console.log('[RSS] end');
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
		sharedBy?: string;
		originalTweetUrl?: string;
		tweetText?: string;
		authorName?: string;
		authorUserName?: string;
		authorProfilePicture?: string;
		authorVerified?: boolean;
		media?: Array<{ url: string; type: string }>;
		createdAt?: string;
	}
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
		platform_metadata: {
			type: 'twitter',
			fetchedAt: new Date().toISOString(),
			data: {
				variant: 'shared',
				authorName: data.authorName || '',
				authorUserName: data.authorUserName || '',
				authorProfilePicture: data.authorProfilePicture,
				authorVerified: data.authorVerified,
				mediaUrls: data.media?.map((m) => m.url).filter(Boolean),
				media: data.media || [],
				createdAt: data.createdAt,
				tweetText: data.tweetText,
				sharedBy: data.sharedBy,
				originalTweetUrl: data.originalTweetUrl,
				externalUrl: data.url,
				externalOgImage: data.ogImage,
				externalTitle: data.title,
			},
		},
	};

	const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');

	if (error) {
		console.error('[TWITTER] Insert scraped article error:', error);
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

	console.log(`[TWITTER] Saved scraped article: ${data.title.slice(0, 50)}`);
	return true;
}

function extractTweetMedia(tweet: Tweet): Array<{ url: string; type: string }> {
	return (
		tweet.extendedEntities?.media?.flatMap((m) =>
			m.media_url_https ? [{ url: m.media_url_https, type: m.type }] : []
		) ?? []
	);
}

async function saveTweet(tweet: Tweet, supabase: any, env: Env): Promise<boolean> {
	const table = getArticlesTable(env);

	// Check for duplicates
	const { data: existing } = await supabase.from(table).select('id').eq('url', tweet.url).single();
	if (existing) return false;

	// Check for Twitter Article via expanded URLs
	const expandedUrls = (tweet.urls || []).map((u: any) => u.expanded_url || u.url || u).filter(Boolean) as string[];
	const articleUrl = expandedUrls.find((u) => /(?:twitter\.com|x\.com)\/i\/article\//.test(u));

	if (articleUrl) {
		const tweetId = tweet.id || tweet.url.split('/').pop();
		if (tweetId) {
			console.log(`[TWITTER] Detected Twitter Article in tweet ${tweetId}: ${articleUrl}`);
			const articleContent = await scrapeTwitterArticle(tweetId, env.KAITO_API_KEY || '');
			if (articleContent) {
				const articleData = {
					url: tweet.url,
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
					platform_metadata: {
						type: 'twitter',
						fetchedAt: new Date().toISOString(),
						data: {
							...articleContent.metadata,
							authorName: articleContent.metadata?.authorName || tweet.author?.name || '',
							authorUserName: articleContent.metadata?.authorUserName || tweet.author?.userName || '',
							authorProfilePicture: articleContent.metadata?.authorProfilePicture || (tweet.author as any)?.profilePicture,
							authorVerified: articleContent.metadata?.authorVerified ?? tweet.author?.verified,
						},
					},
				};

				const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');
				if (error) {
					console.error('[TWITTER] Insert article error:', error);
					return false;
				}

				const articleId = inserted?.[0]?.id;
				if (articleId) {
					await env.ARTICLE_QUEUE.send({ type: 'article_process', article_id: articleId, source_type: 'twitter' });
				}
				console.log(`[TWITTER] Saved Twitter Article: ${articleContent.title.slice(0, 50)}`);
				return true;
			}
			console.warn(`[TWITTER] Article API failed, falling through to regular tweet handling`);
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
		env.OPENROUTER_API_KEY
	);

	// Handle based on assessment
	if (assessment.action === 'discard') {
		console.log(`[TWITTER] Filtered: @${tweet.author?.userName} - ${assessment.reason}`);
		return false;
	}

	if (assessment.action === 'follow_link' && links.length > 0) {
		// Resolve and scrape link content
		const resolvedUrl = await resolveUrl(links[0]!);

		// Skip social media links
		if (isSocialMediaUrl(resolvedUrl)) {
			console.log(`[TWITTER] Skipped social media link: ${resolvedUrl}`);
			return false;
		}

		// Check if link already exists
		const { data: linkExists } = await supabase.from(table).select('id').eq('url', resolvedUrl).single();
		if (linkExists) {
			console.log(`[TWITTER] Link already exists: ${resolvedUrl}`);
			return false;
		}

		// Scrape link content
		const scrapedContent = await scrapeArticleContent(resolvedUrl);
		const ogImage = await extractOgImage(resolvedUrl);

		// Re-assess scraped content
		const scrapedAssessment = await assessContent(
			{
				title: extractTitleFromHtml(scrapedContent) ?? `Shared by @${tweet.author?.userName}`,
				text: scrapedContent,
				url: resolvedUrl,
				source: 'Twitter',
				sourceType: 'twitter',
			},
			env.OPENROUTER_API_KEY
		);

		if (scrapedAssessment.action === 'discard') {
			console.log(`[TWITTER] Scraped content filtered: ${scrapedAssessment.reason}`);
			return false;
		}

		return saveScrapedArticle(supabase, env, {
			url: resolvedUrl,
			title: extractTitleFromHtml(scrapedContent) ?? 'Shared Article',
			content: scrapedContent,
			source: 'Twitter',
			sourceType: 'twitter',
			ogImage,
			sharedBy: tweet.author?.userName,
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

	// Fetch external link's og:image and title
	let externalOgImage: string | null = null;
	let externalTitle: string | null = null;
	if (externalUrl) {
		try {
			const [ogImage, scrapedHtml] = await Promise.all([
				extractOgImage(externalUrl),
				scrapeArticleContent(externalUrl),
			]);
			externalOgImage = ogImage;
			externalTitle = extractTitleFromHtml(scrapedHtml);
		} catch {
			console.warn(`[TWITTER] Failed to fetch external link metadata: ${externalUrl}`);
		}
	}

	const tweetMedia = extractTweetMedia(tweet);

	const articleData = {
		url: tweet.url,
		title: `@${tweet.author?.userName}: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? '...' : ''}`,
		source: 'Twitter',
		published_date: new Date(tweet.createdAt),
		scraped_date: new Date(),
		keywords: tweet.hashTags || [],
		tags: [],
		tokens: [],
		summary: tweet.text,
		source_type: 'twitter',
		content: null,
		og_image_url: tweetMedia[0]?.url ?? externalOgImage ?? null,
		platform_metadata: {
			type: 'twitter',
			fetchedAt: new Date().toISOString(),
			data: {
				authorName: tweet.author?.name || '',
				authorUserName: tweet.author?.userName || '',
				authorProfilePicture: (tweet.author as any)?.profilePicture,
				authorVerified: tweet.author?.verified ?? (tweet.author as any)?.isBlueVerified,
				mediaUrls: tweetMedia.map((m) => m.url),
				media: tweetMedia,
				createdAt: tweet.createdAt,
				...(externalUrl && {
					variant: 'shared',
					externalUrl,
					externalOgImage,
					externalTitle,
					tweetText: textWithoutUrls,
					sharedBy: tweet.author?.userName,
					originalTweetUrl: tweet.url,
				}),
			},
		},
	};

	const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');
	if (error) {
		console.error('[TWITTER] insert error:', error);
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

	console.log(`[TWITTER] Saved tweet: @${tweet.author?.userName} (score: ${assessment.score})`);
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
	console.log('[TWITTER] start');
	const supabase = getSupabaseClient(env);
	const results = await Promise.all(
		TWITTER_LISTS.map((listId) => fetchHighViewTweets(env.KAITO_API_KEY || '', listId, supabase, env))
	);
	console.log(`[TWITTER] end, inserted: ${results.reduce((a, b) => a + b, 0)}`);
}

// ─────────────────────────────────────────────────────────────
// Retry Failed Articles
// ─────────────────────────────────────────────────────────────

const RETRY_BATCH_SIZE = 20;

export async function handleRetryCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.log('[RETRY] start');
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);
	const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

	const { data, error } = await supabase
		.from(table)
		.select('id')
		.gte('scraped_date', since)
		.or('title_cn.is.null,summary_cn.is.null,embedding.is.null');

	if (error) return console.error('[RETRY] query failed:', error);
	if (!data?.length) return console.log('[RETRY] no incomplete articles');

	const ids: string[] = data.map((r: { id: string }) => r.id);
	for (let i = 0; i < ids.length; i += RETRY_BATCH_SIZE) {
		await env.ARTICLE_QUEUE.send({
			type: 'batch_process',
			article_ids: ids.slice(i, i + RETRY_BATCH_SIZE),
			triggered_by: 'retry_cron',
		});
	}
	console.log(`[RETRY] queued ${ids.length} articles in ${Math.ceil(ids.length / RETRY_BATCH_SIZE)} batches`);
}
