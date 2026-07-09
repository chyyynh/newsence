import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { withCoreDb } from '@db/client';
import { rssList } from '@db/schema';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { getExistingResourcesByUrl, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { enqueueProcessing } from '@ingest/workflow';
import { and, eq } from 'drizzle-orm';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const FEED_CONCURRENCY = 4;
const ITEM_CONCURRENCY = 5;

type RssSource = {
	id: number;
	name: string;
	RSSLink: string | null;
};

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
				summary: description,
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
	if (!feed.RSSLink) return console.warn({ tag: 'RSS', msg: 'Feed has no RSSLink', feed: feed.name });

	let res: Response;
	try {
		res = await fetchWithTimeout(feed.RSSLink, {
			headers: {
				'User-Agent': FEED_UA,
				Accept: 'application/rss+xml, application/xml, text/xml, */*',
			},
		});
	} catch (err) {
		return console.warn({ tag: 'RSS', msg: 'Feed fetch failed', feed: feed.name, error: String(err) });
	}
	if (!res.ok) {
		await res.body?.cancel();
		return console.warn({ tag: 'RSS', msg: 'Feed fetch failed', feed: feed.name, status: res.status });
	}

	const items = (
		extractFromXml(await readTextWithLimit(res, MAX_FEED_BYTES), {
			descriptionMaxLen: 0,
		}).entries ?? []
	).slice(0, 30) as FeedEntry[];
	if (!items.length) {
		console.info({ tag: 'RSS', msg: 'Feed has no items', feed: feed.name });
		await markFeedScraped(env, feed.id);
		return;
	}

	const itemUrlsByUrl = new Map<string, { item: FeedEntry; url: string }>();
	for (const item of items) {
		const url = normalizeFeedItemUrl(item.link);
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
	await markFeedScraped(env, feed.id);
}

async function markFeedScraped(env: CoreEnv, feedId: number): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db.update(rssList).set({ scrapedAt: new Date() }).where(eq(rssList.id, feedId));
	});
}

export async function handleRSSCron(env: CoreEnv): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const feeds = await withCoreDb(env, async (db) =>
		db
			.select({ id: rssList.id, name: rssList.name, RSSLink: rssList.rssLink })
			.from(rssList)
			.where(and(eq(rssList.isDefault, true), eq(rssList.type, 'rss'))),
	);
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
