import { normalizeUrl } from '@core-shared/url';
import { withCoreDb, withCoreTx } from '@db/client';
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
	const resourceId = await withCoreTx(env, (db) =>
		upsertPendingSourceResource(db, {
			sourceId: feed.id,
			url,
			title,
			source: feed.name,
			publishedDate: feedPublishedDate(item.published),
			summary: feedSummary(item.summary),
			kind: 'document',
			resourcePlatform: null,
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
 * Claims rows that already existed before this feed was monitored — a saved URL,
 * or an entry that resolved to a special platform (Hacker News from hnrss,
 * YouTube from a channel feed). Only unowned rows are sent, so after the first cycle
 * this issues no statement at all.
 */
async function reattachFeedProvenance(env: CoreEnv, feed: RssSource, existing: ExistingResourceRecord[]): Promise<void> {
	const unowned = existing.filter((resource) => resource.needsSourceAttach).map((resource) => resource.id);
	if (!unowned.length) return;
	await withCoreDb(env, (db) => attachSourceToResources(db, unowned, feed.id));
}

/** Runs `work` over `items` in bounded batches, isolating and logging each failure. */
async function enqueueInBatches<T>(items: T[], describe: (item: T) => string, msg: string, work: (item: T) => Promise<unknown>) {
	let done = 0;
	for (let index = 0; index < items.length; index += ITEM_CONCURRENCY) {
		const batch = items.slice(index, index + ITEM_CONCURRENCY);
		const results = await Promise.allSettled(batch.map(work));
		for (const [resultIndex, result] of results.entries()) {
			if (result.status === 'fulfilled') {
				done++;
				continue;
			}
			console.error({
				tag: 'RSS',
				msg,
				url: describe(batch[resultIndex] as T),
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			});
		}
	}
	return done;
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
	const retryable = existing.filter((resource) => resource.shouldRetryEnrichment);
	const retried = await enqueueInBatches(
		retryable,
		(r) => r.url,
		'Existing resource retry enqueue failed',
		(r) => enqueueProcessing(env, r.id),
	);
	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, mode, newCount: newItems.length, retried, totalCount: items.length });

	const queued = await enqueueInBatches(
		newItems,
		({ url }) => url,
		'Item enqueue failed',
		({ item, url }) => enqueueFeedItem(env, feed, item, url),
	);
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
	await markSourceScraped(env, feed.id);
}

export async function handleRSSCron(env: CoreEnv): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	// Every feed-discovered source, whatever its platform says: a YouTube channel
	// handle is an Atom feed URL, so there is nothing for a separate monitor to do.
	// Its entries still resolve to resource_platform='youtube' at acquisition.
	const feeds = await loadMonitoredSources(env, 'feed');
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
