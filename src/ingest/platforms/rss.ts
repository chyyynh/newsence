import type { ContentResourceType } from '@core-shared/resource-types';
import { normalizeUrl } from '@core-shared/url';
import { withCoreDb } from '@db/client';
import {
	attachSourceToResources,
	type ExistingResourceRecord,
	getExistingResourcesByUrl,
	upsertPendingSourceResource,
} from '@ingest/domain/resource-store';
import {
	loadMonitoredSources,
	type MonitoredSource,
	markSourceScraped,
	parseRssAcquisitionMode,
	recordSourceFailure,
} from '@ingest/domain/source-store';
import { enqueueProcessing } from '@ingest/workflow';
import { canonicalFeedItemUrl, type FeedItem, feedItemMarkdown, feedPublishedDate, feedSummary, loadFeedEntries } from './rss-feed';

const FEED_CONCURRENCY = 4;
const ITEM_CONCURRENCY = 5;

type RssSource = MonitoredSource;

async function enqueueFeedItem(env: CoreEnv, feed: RssSource, item: FeedItem, url: string): Promise<void> {
	const title = item.title?.trim();
	if (!title) throw new Error(`RSS item from ${feed.name} has no title: ${url}`);
	const mode = parseRssAcquisitionMode(feed.acquisitionMode, feed.name);
	const content = mode === 'feed' ? await feedItemMarkdown(env, item, url) : null;
	const resourceId = await withCoreDb(env, (db) =>
		upsertPendingSourceResource(db, {
			sourceId: feed.id,
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

function dedupedFeedItems(items: FeedItem[], feedName: string): Array<{ item: FeedItem; url: string }> {
	const byUrl = new Map<string, { item: FeedItem; url: string }>();
	for (const item of items) {
		const url = canonicalFeedItemUrl(item);
		if (url && !byUrl.has(url)) byUrl.set(url, { item, url });
	}
	const deduped = [...byUrl.values()];
	const skipped = items.length - deduped.length;
	if (skipped) console.warn({ tag: 'RSS', msg: 'Skipped invalid or duplicate feed items', feed: feedName, count: skipped });
	return deduped;
}

/**
 * A feed entry can resolve to a type other than 'rss': hnrss items become
 * 'hackernews', and a channel's Atom feed yields 'youtube'. Provenance is
 * re-attached per resolved type, so a row saved before its feed was monitored
 * still gains the source.
 */
async function reattachFeedProvenance(env: CoreEnv, feed: RssSource, existing: ExistingResourceRecord[]): Promise<void> {
	const idsByType = new Map<ContentResourceType, string[]>();
	for (const resource of existing) {
		const ids = idsByType.get(resource.type) ?? [];
		ids.push(resource.id);
		idsByType.set(resource.type, ids);
	}
	await withCoreDb(env, async (db) => {
		for (const [type, ids] of idsByType) await attachSourceToResources(db, ids, feed.id, type);
	});
}

/** Re-enqueues rows the monitor still considers retryable, isolating each failure. */
async function retryExistingResources(env: CoreEnv, feed: RssSource, existing: ExistingResourceRecord[]): Promise<number> {
	let retried = 0;
	for (const resource of existing) {
		if (!resource.shouldRetryEnrichment) continue;
		try {
			await enqueueProcessing(env, resource.id);
			retried++;
		} catch (error) {
			console.error({
				tag: 'RSS',
				msg: 'Existing resource retry enqueue failed',
				feed: feed.name,
				url: resource.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return retried;
}

async function enqueueNewFeedItems(env: CoreEnv, feed: RssSource, newItems: Array<{ item: FeedItem; url: string }>): Promise<number> {
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
	return queued;
}

async function processFeed(env: CoreEnv, feed: RssSource): Promise<void> {
	const mode = parseRssAcquisitionMode(feed.acquisitionMode, feed.name);
	const items = await loadFeedEntries(feed.handle);
	if (!items.length) {
		console.info({ tag: 'RSS', msg: 'Feed has no items', feed: feed.name });
		await markSourceScraped(env, feed.id);
		return;
	}

	const itemUrls = dedupedFeedItems(items, feed.name);
	const existing = await withCoreDb(env, (db) =>
		getExistingResourcesByUrl(
			db,
			itemUrls.map(({ url }) => url),
		),
	);
	await reattachFeedProvenance(env, feed, existing);

	const existingSet = new Set(existing.map((resource) => normalizeUrl(resource.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));
	const retried = await retryExistingResources(env, feed, existing);
	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, mode, newCount: newItems.length, retried, totalCount: items.length });

	const queued = await enqueueNewFeedItems(env, feed, newItems);
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
	await markSourceScraped(env, feed.id);
}

export async function handleRSSCron(env: CoreEnv): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	// YouTube channels are polled here: a channel handle is an Atom feed URL, so
	// there is nothing for a separate monitor to do. They keep platform='youtube'
	// for the plan quota and the source list, and their entries resolve back to
	// type='youtube' at acquisition.
	const feeds = await loadMonitoredSources(env, ['rss', 'youtube']);
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
				const failedFeed = batch[resultIndex];
				if (failedFeed) await recordSourceFailure(env, failedFeed.id, result.reason);
			}
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
