import { fetchWithTimeout, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { normalizeUrl } from '@core-shared/url';
import { withCoreDb } from '@db/client';
import { sanitizeExtractedMarkdown } from '@ingest/domain/content-sanitization';
import { getExistingResourcesByUrl, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { loadEnabledSources, type MonitoredSource, markSourceScraped } from '@ingest/domain/source-store';
import { enqueueProcessing } from '@ingest/workflow';
import { parseFeed } from 'feedsmith';
import { decode } from 'html-entities';
import { markdownFromHtml } from '../web-acquisition';
import { hackerNewsDiscussionUrl } from './hackernews';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const MAX_FEED_ITEMS = 30;
const FEED_CONCURRENCY = 4;
const ITEM_CONCURRENCY = 5;
const FEED_SUMMARY_MAX_CHARS = 500;

type RssSource = MonitoredSource;
type RssContentMode = 'feed' | 'web';
type ParsedFeed = ReturnType<typeof parseFeed>;
type ParsedRssItem = NonNullable<Extract<ParsedFeed, { format: 'rss' }>['feed']['items']>[number];
type ParsedAtomEntry = NonNullable<Extract<ParsedFeed, { format: 'atom' }>['feed']['entries']>[number];
type ParsedRdfItem = NonNullable<Extract<ParsedFeed, { format: 'rdf' }>['feed']['items']>[number];
type ParsedJsonItem = NonNullable<Extract<ParsedFeed, { format: 'json' }>['feed']['items']>[number];

interface FeedMedia {
	thumbnails?: Array<{ url?: string }>;
	contents?: Array<{ url?: string; type?: string; medium?: string }>;
	groups?: Array<{
		thumbnails?: Array<{ url?: string }>;
		contents?: Array<{ url?: string; type?: string; medium?: string }>;
	}>;
}

interface FeedItemContent {
	format: 'html' | 'text';
	value: string;
}

interface FeedItem {
	id: string;
	link?: string;
	title?: string;
	summary?: string;
	content?: FeedItemContent;
	published?: string;
	language?: string;
	previewImageUrl?: string;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function decodedString(value: unknown): string | undefined {
	const text = optionalString(value);
	return text ? decode(text).trim() || undefined : undefined;
}

function rssContentMode(feed: RssSource): RssContentMode {
	if (feed.contentMode === 'feed' || feed.contentMode === 'web') return feed.contentMode;
	throw new Error(`RSS source ${feed.name} has invalid content mode: ${String(feed.contentMode)}`);
}

function alternateAtomLink(entry: ParsedAtomEntry): string | undefined {
	const links = entry.links ?? [];
	return optionalString(links.find((link) => !link.rel || link.rel === 'alternate')?.href) ?? optionalString(links[0]?.href);
}

function firstMediaImage(media: FeedMedia | undefined): string | undefined {
	const groups = media?.groups ?? [];
	const thumbnails = [...(media?.thumbnails ?? []), ...groups.flatMap((group) => group.thumbnails ?? [])];
	const thumbnail = thumbnails.map((item) => optionalString(item.url)).find(Boolean);
	if (thumbnail) return thumbnail;

	const contents = [...(media?.contents ?? []), ...groups.flatMap((group) => group.contents ?? [])];
	return contents
		.filter((item) => item.medium === 'image' || item.type?.toLowerCase().startsWith('image/'))
		.map((item) => optionalString(item.url))
		.find(Boolean);
}

function firstHtmlImage(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = value.match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
	return optionalString(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function resolvedHttpUrl(value: string | undefined, baseUrl: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value, baseUrl);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function rssFeedItem(item: ParsedRssItem, language: string | undefined): FeedItem {
	const itemLink = optionalString(item.link);
	const guid = optionalString(item.guid?.value);
	const permalinkGuid = item.guid?.isPermaLink !== false && guid?.match(/^https?:\/\//i) ? guid : undefined;
	const link = permalinkGuid ?? itemLink;
	const summary = optionalString(item.description);
	const encodedContent = optionalString(item.content?.encoded);
	const content = encodedContent ?? summary;
	const previewImage = firstMediaImage(item.media) ?? firstHtmlImage(content);
	return {
		id: guid ?? link ?? '',
		link,
		title: decodedString(item.title),
		summary,
		content: content ? { format: 'html', value: content } : undefined,
		published: optionalString(item.pubDate) ?? optionalString(item.dc?.dates?.[0]),
		language,
		previewImageUrl: resolvedHttpUrl(previewImage, link),
	};
}

function atomFeedItem(entry: ParsedAtomEntry): FeedItem {
	const link = alternateAtomLink(entry);
	const content = optionalString(entry.content);
	const previewImage = firstMediaImage(entry.media) ?? firstHtmlImage(content);
	return {
		id: optionalString(entry.id) ?? link ?? '',
		link,
		title: decodedString(entry.title),
		summary: optionalString(entry.summary),
		content: content ? { format: 'html', value: content } : undefined,
		published: optionalString(entry.published) ?? optionalString(entry.updated),
		language: optionalString(entry.dc?.languages?.[0]),
		previewImageUrl: resolvedHttpUrl(previewImage, link),
	};
}

function rdfFeedItem(item: ParsedRdfItem, language: string | undefined): FeedItem {
	const link = optionalString(item.link);
	const summary = optionalString(item.description);
	const encodedContent = optionalString(item.content?.encoded);
	const content = encodedContent ?? summary;
	const previewImage = firstMediaImage(item.media) ?? firstHtmlImage(content);
	return {
		id: optionalString(item.rdf?.about) ?? link ?? '',
		link,
		title: decodedString(item.title),
		summary,
		content: content ? { format: 'html', value: content } : undefined,
		published: optionalString(item.dc?.dates?.[0]),
		language,
		previewImageUrl: resolvedHttpUrl(previewImage, link),
	};
}

function jsonFeedItem(item: ParsedJsonItem, feedLanguage: string | undefined): FeedItem {
	const link = optionalString(item.url) ?? optionalString(item.external_url);
	const html = optionalString(item.content_html);
	const text = optionalString(item.content_text);
	return {
		id: optionalString(item.id) ?? link ?? '',
		link,
		title: decodedString(item.title),
		summary: optionalString(item.summary),
		content: html ? { format: 'html', value: html } : text ? { format: 'text', value: text } : undefined,
		published: optionalString(item.date_published) ?? optionalString(item.date_modified),
		language: optionalString(item.language) ?? feedLanguage,
		previewImageUrl: resolvedHttpUrl(optionalString(item.image) ?? optionalString(item.banner_image), link),
	};
}

function parseFeedItems(body: string): FeedItem[] {
	const parsed = parseFeed(body, { maxItems: MAX_FEED_ITEMS });
	if (parsed.format === 'rss') {
		const language = optionalString(parsed.feed.language);
		return (parsed.feed.items ?? []).map((item) => rssFeedItem(item, language));
	}
	if (parsed.format === 'atom') return (parsed.feed.entries ?? []).map(atomFeedItem);
	if (parsed.format === 'rdf') {
		const language = optionalString(parsed.feed.dc?.languages?.[0]);
		return (parsed.feed.items ?? []).map((item) => rdfFeedItem(item, language));
	}
	const language = optionalString(parsed.feed.language);
	return (parsed.feed.items ?? []).map((item) => jsonFeedItem(item, language));
}

async function loadFeedEntries(feed: RssSource): Promise<FeedItem[]> {
	const response = await fetchWithTimeout(feed.handle, {
		headers: {
			'User-Agent': WEB_FETCH_USER_AGENT,
			Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*',
		},
	});

	if (response.ok) return parseFeedItems(await readTextWithLimit(response, MAX_FEED_BYTES));

	const status = response.status;
	await response.body?.cancel();
	throw new Error(`RSS feed ${feed.name} failed with HTTP ${status}`);
}

function normalizeFeedItemUrl(value: string | undefined): string | null {
	if (!value) return null;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		return normalizeUrl(parsed.toString());
	} catch {
		return null;
	}
}

function canonicalFeedItemUrl(item: FeedItem): string | null {
	return normalizeFeedItemUrl(hackerNewsDiscussionUrl(item.id) ?? item.link);
}

function feedPublishedDate(value: string | undefined): Date {
	if (!value) return new Date();
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

function feedSummary(value: string | undefined): string | null {
	if (!value) return null;
	const summary = decode(value.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
	return summary ? summary.slice(0, FEED_SUMMARY_MAX_CHARS) : null;
}

async function feedItemMarkdown(env: CoreEnv, item: FeedItem, url: string): Promise<string> {
	if (!item.content) throw new Error(`RSS feed item has no content: ${url}`);
	const converted = item.content.format === 'html' ? await markdownFromHtml(env, item.content.value, url) : item.content.value;
	const markdown = sanitizeExtractedMarkdown(converted);
	if (!markdown) throw new Error(`RSS feed item produced empty Markdown: ${url}`);
	return markdown;
}

async function enqueueFeedItem(env: CoreEnv, feed: RssSource, item: FeedItem, url: string): Promise<void> {
	const title = item.title?.trim();
	if (!title) throw new Error(`RSS item from ${feed.name} has no title: ${url}`);
	const mode = rssContentMode(feed);
	const content = mode === 'feed' ? await feedItemMarkdown(env, item, url) : null;
	const resourceId = await withCoreDb(env, (db) =>
		upsertPendingSourceResource(db, {
			url,
			title,
			source: feed.name,
			publishedDate: feedPublishedDate(item.published),
			summary: feedSummary(item.summary),
			type: 'rss',
			originalLang: item.language,
			content,
			platformMetadata: mode === 'feed' ? { fetchedAt: new Date().toISOString(), data: null } : null,
			previewImageUrl: item.previewImageUrl,
		}),
	);
	await enqueueProcessing(env, resourceId);
}

async function processFeed(env: CoreEnv, feed: RssSource): Promise<void> {
	const mode = rssContentMode(feed);
	const items = await loadFeedEntries(feed);
	if (!items.length) {
		console.info({ tag: 'RSS', msg: 'Feed has no items', feed: feed.name });
		await markSourceScraped(env, feed.id);
		return;
	}

	const itemUrlsByUrl = new Map<string, { item: FeedItem; url: string }>();
	for (const item of items) {
		const url = canonicalFeedItemUrl(item);
		if (url && !itemUrlsByUrl.has(url)) itemUrlsByUrl.set(url, { item, url });
	}
	const itemUrls = [...itemUrlsByUrl.values()];
	const skippedInvalid = items.length - itemUrls.length;
	if (skippedInvalid) console.warn({ tag: 'RSS', msg: 'Skipped invalid or duplicate feed items', feed: feed.name, count: skippedInvalid });
	const urls = itemUrls.map(({ url }) => url);
	const existingRecords = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, urls));
	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));
	let retried = 0;
	for (const existing of existingRecords) {
		if (!existing.shouldRetryEnrichment) continue;
		try {
			await enqueueProcessing(env, existing.id);
			retried++;
		} catch (error) {
			console.error({
				tag: 'RSS',
				msg: 'Existing resource retry enqueue failed',
				feed: feed.name,
				url: existing.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, mode, newCount: newItems.length, retried, totalCount: items.length });
	let queued = 0;
	for (let index = 0; index < newItems.length; index += ITEM_CONCURRENCY) {
		const batch = newItems.slice(index, index + ITEM_CONCURRENCY);
		const results = await Promise.allSettled(batch.map(({ item, url }) => enqueueFeedItem(env, feed, item, url)));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				queued++;
				continue;
			}
			console.error({
				tag: 'RSS',
				msg: 'Item enqueue failed',
				feed: feed.name,
				url: batch[resultIndex]?.url,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
	await markSourceScraped(env, feed.id);
}

export async function handleRSSCron(env: CoreEnv): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const feeds = await loadEnabledSources(env, 'rss');
	for (let index = 0; index < feeds.length; index += FEED_CONCURRENCY) {
		const batch = feeds.slice(index, index + FEED_CONCURRENCY);
		const results = await Promise.allSettled(batch.map((feed) => processFeed(env, feed)));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'rejected') {
				console.error({
					tag: 'RSS',
					msg: 'Feed processing failed',
					feed: batch[resultIndex]?.name,
					error: result.reason instanceof Error ? result.reason.message : String(result.reason),
				});
			}
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
