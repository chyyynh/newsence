import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { withCoreDb } from '@db/client';
import { rssList } from '@db/schema';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { getExistingResourcesByUrl, upsertPendingSourceResource } from '@ingest/domain/resource-store';
import { enqueueProcessing } from '@ingest/workflow';
import { and, eq } from 'drizzle-orm';

const MAX_FEED_BYTES = 3 * 1024 * 1024;

type RssSource = {
	id: number;
	name: string;
	RSSLink: string | null;
};

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
	if (!res.ok) return console.warn({ tag: 'RSS', msg: 'Feed fetch failed', feed: feed.name, status: res.status });

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

	const itemUrls = items.flatMap((item) => (item.link ? [{ item, url: normalizeUrl(item.link) }] : []));
	const urls = itemUrls.map(({ url }) => url);
	const existingRecords = await withCoreDb(env, (db) => getExistingResourcesByUrl(db, urls));
	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, totalCount: items.length });
	let queued = 0;
	for (const { item, url } of newItems) {
		try {
			const description = item.description?.trim() ?? '';
			const resourceId = await withCoreDb(env, (db) =>
				upsertPendingSourceResource(db, {
					url,
					title: item.title || 'No Title',
					source: feed.name,
					publishedDate: item.published ? new Date(item.published) : new Date(),
					summary: description,
					type: 'rss',
					content: null,
					platformMetadata: null,
				}),
			);
			await enqueueProcessing(env, {
				kind: 'resource',
				rowId: resourceId,
			});
			queued++;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Item enqueue failed, skipping', feed: feed.name, url, error: String(err) });
		}
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
	for (const feed of feeds) {
		try {
			await processFeed(env, feed);
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Feed failed', feed: feed.name, error: String(err) });
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
