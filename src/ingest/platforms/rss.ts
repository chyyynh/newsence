import { normalizeUrl } from '@core-shared/url';
import { withCoreDb } from '@db/client';
import { getExistingResourcesByUrl, recordRssFeedProvenance, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { loadEnabledSources, type MonitoredSource, markSourceScraped, parseRssContentMode } from '@ingest/domain/source-store';
import { enqueueProcessing } from '@ingest/workflow';
import { canonicalFeedItemUrl, type FeedItem, feedItemMarkdown, feedPublishedDate, feedSummary, loadFeedEntries } from './rss-feed';

const FEED_CONCURRENCY = 4;
const ITEM_CONCURRENCY = 5;

type RssSource = MonitoredSource;

async function enqueueFeedItem(env: CoreEnv, feed: RssSource, item: FeedItem, url: string): Promise<void> {
	const title = item.title?.trim();
	if (!title) throw new Error(`RSS item from ${feed.name} has no title: ${url}`);
	const mode = parseRssContentMode(feed.contentMode, feed.name);
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
			platformMetadata: mode === 'feed' ? { fetchedAt: new Date().toISOString(), data: { sourceId: feed.id } } : null,
			previewImageUrl: item.previewImageUrl,
		}),
	);
	await enqueueProcessing(env, resourceId);
}

async function processFeed(env: CoreEnv, feed: RssSource): Promise<void> {
	const mode = parseRssContentMode(feed.contentMode, feed.name);
	const items = await loadFeedEntries(feed.handle);
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
	if (mode === 'feed') {
		const rssResourceIds = existingRecords.filter((resource) => resource.type === 'rss').map((resource) => resource.id);
		await withCoreDb(env, (db) => recordRssFeedProvenance(db, rssResourceIds, feed.name, { sourceId: feed.id })).catch((error) =>
			console.error({
				tag: 'RSS',
				msg: 'Feed provenance backfill failed',
				feed: feed.name,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
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
