import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { getExistingArticlesByUrl } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import { Client } from 'pg';

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const RSS_SOURCE_FIELDS = 'id, name, "RSSLink"';

type RssSource = {
	id: string;
	name: string;
	RSSLink: string;
};

async function processFeed(env: Env, db: Client, feed: RssSource): Promise<void> {
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
		await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
		return;
	}

	const itemUrls = items.flatMap((item) => (item.link ? [{ item, url: normalizeUrl(item.link) }] : []));
	const urls = itemUrls.map(({ url }) => url);
	const existingRecords = await getExistingArticlesByUrl(db, urls);
	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, totalCount: items.length });
	let queued = 0;
	for (const { item, url } of newItems) {
		try {
			const description = item.description ?? '';
			await enqueueProcessing(env, {
				kind: 'source',
				draft: {
					article: {
						url,
						title: item.title || 'No Title',
						source: feed.name,
						publishedDate: item.published ? new Date(item.published) : new Date(),
						summary: description,
						sourceType: 'rss',
						content: description || null,
						ogImageUrl: null,
						platformMetadata: null,
					},
				},
			});
			queued++;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Item enqueue failed, skipping', feed: feed.name, url, error: String(err) });
		}
	}
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
}

export async function handleRSSCron(env: Env): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const feeds = (await db.query<RssSource>(`SELECT ${RSS_SOURCE_FIELDS} FROM "RssList" WHERE is_default = true AND type = 'rss'`)).rows;
	for (const feed of feeds) {
		try {
			await processFeed(env, db, feed);
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Feed failed', feed: feed.name, error: String(err) });
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
