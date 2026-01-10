import { XMLParser } from 'fast-xml-parser';
import { Env, ExecutionContext } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { normalizeUrl, scrapeArticleContent, extractOgImage } from '../utils/rss';
import { fetchPlatformMetadata } from '../utils/platform-metadata';

type RSSItem = Record<string, any>;
type RSSFeed = { id: string; name: string; RSSLink: string; url: string; type: string };

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles_test_core';
}

function extractUrlFromItem(item: RSSItem, isArxiv: boolean): string | null {
	if (isArxiv) {
		if (item.id) return item.id;
		if (typeof item.link === 'string') return item.link;
		if (Array.isArray(item.link)) {
			const absLink = item.link.find((l: any) => l['@_href']?.includes('/abs/'));
			return absLink?.['@_href'] ?? item.link[0]?.['@_href'] ?? null;
		}
		return item.link?.['@_href'] ?? null;
	}

	if (typeof item.link === 'string') return item.link;
	if (item.link?.['@_href']) return item.link['@_href'];
	if (item.link?.href) return item.link.href;
	return item.url ?? null;
}

function extractArxivExtensions(item: RSSItem): string {
	let extensions = '';

	if (item.author) {
		let authors = '';
		if (Array.isArray(item.author)) {
			authors = item.author.map((a: any) => a.name ?? a).join(', ');
		} else if (typeof item.author === 'object' && item.author.name) {
			authors = item.author.name;
		} else if (typeof item.author === 'string') {
			authors = item.author;
		}
		if (authors) extensions += `\n\nAuthors: ${authors}`;
	}

	if (item.category) {
		let categories = '';
		if (Array.isArray(item.category)) {
			categories = item.category.map((c: any) => c['@_term'] ?? c).join(', ');
		} else if (typeof item.category === 'object' && item.category['@_term']) {
			categories = item.category['@_term'];
		} else if (typeof item.category === 'string') {
			categories = item.category;
		}
		if (categories) extensions += `\n\nArXiv Categories: ${categories}`;
	}

	return extensions;
}

function extractItemsFromFeed(data: any): RSSItem[] {
	const sources = [
		data?.rss?.channel?.item,
		data?.feed?.entry,
		data?.channel?.item,
		data?.['rdf:RDF']?.item,
	];

	for (const source of sources) {
		if (source) {
			return Array.isArray(source) ? source : [source];
		}
	}

	return [];
}

async function processAndInsertArticle(
	supabase: any,
	env: Env,
	item: RSSItem,
	feed: RSSFeed,
	defaultSourceType: string
): Promise<void> {
	const isArxiv = feed.name?.toLowerCase().includes('arxiv');
	const rawUrl = extractUrlFromItem(item, isArxiv);
	const url = rawUrl ? normalizeUrl(rawUrl) : null;
	const pubDate = item.pubDate ?? item.isoDate ?? item.published ?? item.updated ?? null;

	let platformMetadata = null;
	let sourceType = defaultSourceType;
	let crawledContent = '';
	let ogImageUrl: string | null = null;
	let enrichedTitle: string | null = null;
	let enrichedSummary: string | null = null;

	if (url) {
		// 1. 先抓 platform metadata（YouTube/HN/Twitter 公開 API）
		try {
			const result = await fetchPlatformMetadata(url, env.YOUTUBE_API_KEY, item.comments ?? null, env.KAITO_API_KEY);
			platformMetadata = result.platformMetadata;
			sourceType = result.sourceType; // 使用檢測到的 source type

			// 2. 利用 platform metadata 預填欄位
			if (platformMetadata?.data) {
				const data = platformMetadata.data as Record<string, unknown>;

				// YouTube: 用 thumbnail 作為 og_image
				if (platformMetadata.type === 'youtube') {
					ogImageUrl = (data.thumbnailUrl as string) || null;
					// YouTube description 可以當作 summary
					const desc = data.description as string;
					if (desc && desc.length > 50) {
						enrichedSummary = desc.slice(0, 500);
					}
					console.log(`[${feed.name}] YouTube enriched: thumbnail=${!!ogImageUrl}, desc=${enrichedSummary?.length ?? 0} chars`);
				}

				// HackerNews: 記錄 points 方便後續排序
				if (platformMetadata.type === 'hackernews') {
					const points = data.points as number;
					console.log(`[${feed.name}] HN enriched: ${points} points, ${data.commentCount} comments`);
				}

				// Twitter: 用 media 作為 og_image
				if (platformMetadata.type === 'twitter') {
					const mediaUrls = data.mediaUrls as string[];
					if (mediaUrls?.length > 0) {
						ogImageUrl = mediaUrls[0];
					}
					console.log(`[${feed.name}] Twitter enriched: media=${mediaUrls?.length ?? 0}`);
				}
			}
		} catch (err) {
			console.warn(`[${feed.name}] platform metadata fetch failed:`, err);
		}

		// 3. 非特殊平台才爬網頁內容
		const shouldScrape = !isArxiv && sourceType === 'rss';
		if (shouldScrape) {
			try {
				[crawledContent, ogImageUrl] = await Promise.all([
					scrapeArticleContent(url),
					ogImageUrl ? Promise.resolve(ogImageUrl) : extractOgImage(url), // 已有 og_image 就不再抓
				]);
			} catch (err) {
				console.warn(`[${feed.name}] scrape failed for ${url}:`, err);
			}
		}
	}

	// arXiv 特殊處理
	if (isArxiv) sourceType = 'arxiv';

	const baseContent = isArxiv
		? (item.description ?? item.summary ?? '')
		: (crawledContent || (item.description ?? item.summary ?? ''));

	const insert: Record<string, unknown> = {
		url: url ?? `feed:${feed.id}:${Date.now()}`,
		title: enrichedTitle ?? item.title ?? item.text ?? item.news_title ?? 'No Title',
		source: feed.name ?? 'Unknown',
		published_date: pubDate ? new Date(pubDate) : new Date(),
		scraped_date: new Date(),
		keywords: [],
		tags: [],
		tokens: [],
		summary: enrichedSummary ?? '',
		source_type: sourceType,
		content: baseContent + (isArxiv ? extractArxivExtensions(item) : ''),
		og_image_url: ogImageUrl,
		...(platformMetadata && { platform_metadata: platformMetadata }),
	};

	const table = getArticlesTable(env);
	const { data: inserted, error } = await supabase.from(table).insert([insert]).select('id');

	if (error) {
		console.error(`[${feed.name}] insert error:`, error);
		return;
	}

	const articleId = inserted?.[0]?.id;
	if (!articleId) return;

	try {
		await env.RSS_QUEUE.send({
			type: 'article_scraped',
			article_id: articleId,
			url: insert.url,
			source: insert.source,
			source_type: insert.source_type,
			timestamp: new Date().toISOString(),
		});
		console.log(`[${feed.name}] queued article ${articleId}`);
	} catch (err) {
		console.error(`[${feed.name}] queue send failed:`, err);
	}
}

async function processFeed(supabase: any, env: Env, feed: RSSFeed, parser: XMLParser): Promise<void> {
	if (feed.type !== 'rss') {
		console.log(`[${feed.name}] skip non-rss type`);
		return;
	}

	const isArxiv = feed.name?.toLowerCase().includes('arxiv');
	const isAnthropic = feed.name?.toLowerCase().includes('anthropic');

	const res = await fetch(feed.RSSLink, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
	});

	if (!res.ok) {
		console.warn(`[${feed.name}] fetch failed: ${res.status} ${res.statusText}`);
		return;
	}

	const data = parser.parse(await res.text());
	let items = extractItemsFromFeed(data);

	if (!items.length) {
		console.log(`[${feed.name}] no items`);
		return;
	}

	if (isAnthropic && items.length > 30) {
		items = items.slice(-30);
	} else if (!isArxiv && items.length > 30) {
		items = items.slice(0, 30);
	}

	const urls = items
		.map((item) => extractUrlFromItem(item, isArxiv))
		.filter((url): url is string => !!url)
		.map(normalizeUrl);

	const batchSize = feed.name?.toLowerCase().includes('stratechery') ? 5 : 50;
	const table = getArticlesTable(env);
	const existingUrls: string[] = [];

	for (let i = 0; i < urls.length; i += batchSize) {
		const { data: batch, error } = await supabase.from(table).select('url').in('url', urls.slice(i, i + batchSize));
		if (error) {
			console.error(`[${feed.name}] check existing failed:`, error);
			return;
		}
		if (batch) existingUrls.push(...batch.map((e: { url: string }) => normalizeUrl(e.url)));
	}

	const existingSet = new Set(existingUrls);
	const newItems = items.filter((item) => {
		const url = extractUrlFromItem(item, isArxiv);
		return url && !existingSet.has(normalizeUrl(url));
	});

	console.log(`[${feed.name}] new items: ${newItems.length}/${items.length}`);

	for (const item of newItems) {
		await processAndInsertArticle(supabase, env, item, feed, 'rss');
	}

	await supabase.from('RssList').update({ scraped_at: new Date(), url: feed.url }).eq('id', feed.id);
}

export async function handleRSSCron(env: Env, _ctx: ExecutionContext): Promise<void> {
	console.log('[RSS] cron trigger start');

	const supabase = getSupabaseClient(env);
	const parser = new XMLParser({ ignoreAttributes: false });

	const { data: feeds, error } = await supabase.from('RssList').select('id, name, RSSLink, url, type');
	if (error) {
		console.error('[RSS] failed to fetch RssList:', error);
		return;
	}

	await Promise.allSettled((feeds ?? []).map((feed: RSSFeed) => processFeed(supabase, env, feed, parser)));

	console.log('[RSS] cron trigger end');
}
