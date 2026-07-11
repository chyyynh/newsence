import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { withCoreDb } from '@db/client';
import { extractFromJson, extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { getExistingResourcesByUrl, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { loadEnabledSources, type MonitoredSource, markSourceScraped } from '@ingest/domain/source-store';
import { enqueueProcessing } from '@ingest/workflow';
import { hackerNewsDiscussionUrl } from './hackernews';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const FEED_CONCURRENCY = 4;
const ITEM_CONCURRENCY = 5;
const FEED_SUMMARY_MAX_CHARS = 500;

type RssSource = MonitoredSource;

async function loadFeedEntries(feed: RssSource): Promise<FeedEntry[] | null> {
	let response: Response;
	try {
		response = await fetchWithTimeout(feed.handle, {
			headers: {
				'User-Agent': FEED_UA,
				Accept: 'application/rss+xml, application/xml, text/xml, */*',
			},
		});
	} catch (error) {
		console.warn({ tag: 'RSS', msg: 'Feed fetch failed', feed: feed.name, error: String(error) });
		return null;
	}

	if (response.ok) {
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
		const body = await readTextWithLimit(response, MAX_FEED_BYTES);
		const options = { descriptionMaxLen: 0 };
		const feed =
			contentType.includes('json') || body.trimStart().startsWith('{') ? extractFromJson(body, options) : extractFromXml(body, options);
		return (feed.entries ?? []).slice(0, 30) as FeedEntry[];
	}

	const status = response.status;
	await response.body?.cancel();
	console.warn({ tag: 'RSS', msg: 'Feed fetch failed', feed: feed.name, status });
	return null;
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

function canonicalFeedItemUrl(item: FeedEntry): string | null {
	return normalizeFeedItemUrl(hackerNewsDiscussionUrl(item.id) ?? item.link);
}

function feedPublishedDate(value: string | undefined): Date {
	if (!value) return new Date();
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function enqueueFeedItem(env: CoreEnv, feed: RssSource, item: FeedEntry, url: string): Promise<boolean> {
	try {
		const description = item.description?.trim() ?? '';
		const resourceId = await withCoreDb(env, (db) =>
			upsertPendingSourceResource(db, {
				url,
				title: item.title || 'No Title',
				source: feed.name,
				publishedDate: feedPublishedDate(item.published),
				summary: description.slice(0, FEED_SUMMARY_MAX_CHARS),
				type: 'rss',
				content: null,
				platformMetadata: null,
			}),
		);
		await enqueueProcessing(env, resourceId);
		return true;
	} catch (err) {
		console.warn({ tag: 'RSS', msg: 'Item enqueue failed, skipping', feed: feed.name, url, error: String(err) });
		return false;
	}
}

async function processFeed(env: CoreEnv, feed: RssSource): Promise<void> {
	const items = await loadFeedEntries(feed);
	if (!items) return;
	if (!items.length) {
		console.info({ tag: 'RSS', msg: 'Feed has no items', feed: feed.name });
		await markSourceScraped(env, feed.id);
		return;
	}

	const itemUrlsByUrl = new Map<string, { item: FeedEntry; url: string }>();
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
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Existing resource retry enqueue failed', feed: feed.name, url: existing.url, error: String(err) });
		}
	}

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, retried, totalCount: items.length });
	let queued = 0;
	for (let index = 0; index < newItems.length; index += ITEM_CONCURRENCY) {
		const results = await Promise.all(
			newItems.slice(index, index + ITEM_CONCURRENCY).map(({ item, url }) => enqueueFeedItem(env, feed, item, url)),
		);
		queued += results.filter(Boolean).length;
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
				console.warn({ tag: 'RSS', msg: 'Feed failed', feed: batch[resultIndex]?.name, error: String(result.reason) });
			}
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
