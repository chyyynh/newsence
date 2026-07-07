import { getExistingArticlesByUrl } from '@core-shared/article-store';
import type { PlatformMetadata } from '@core-shared/platform-metadata';
import type { RSSFeed } from '@core-shared/types';
import { decodeHtmlEntities, FEED_UA, fetchWithTimeout, htmlToText, normalizeUrl, readTextWithLimit } from '@core-shared/web';
import { startSourceArticleWorkflow } from '@ingest/workflows/queue';
import { XMLParser } from 'fast-xml-parser';
import { Client } from 'pg';
import { resolveDiscussionPlatformMetadata } from '../registry';
import { scrapeWebPage } from '../web-scraper';

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

const MAX_FEED_BYTES = 3 * 1024 * 1024;
const SOURCE_FEED_FIELDS = 'id, name, "RSSLink", url, type, scraped_at, avatar_url';

type RSSItem = Record<string, unknown>;
type FeedItemWithUrl = { item: RSSItem; url: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function attr(record: Record<string, unknown>, name: string): string | undefined {
	return asString(record[`@_${name}`]) ?? asString(record[name]);
}

function getPath(value: unknown, path: string[]): unknown {
	let current: unknown = value;
	for (const key of path) {
		const record = asRecord(current);
		if (!record) return undefined;
		current = record[key];
	}
	return current;
}

function normalizeItems(value: unknown): RSSItem[] {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	return values.filter((item): item is RSSItem => asRecord(item) !== undefined);
}

function toPlainText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return value.map(toPlainText).filter(Boolean).join(' ');
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		for (const key of ['#text', '_text', 'text', 'value', 'content', 'summary', 'description']) {
			const text = toPlainText(record[key]);
			if (text) return text;
		}
		return Object.values(record).map(toPlainText).filter(Boolean).join(' ');
	}
	return '';
}

function stripHtml(raw: unknown): string {
	return htmlToText(toPlainText(raw));
}

function htmlToMarkdown(html: string): string {
	const markdown = html
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
		.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n')
		.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n')
		.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n')
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
		.replace(/<\/?[ou]l[^>]*>/gi, '\n')
		.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
		.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
		.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
		.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
		.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
		.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, '^($1)')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
		.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) =>
			content
				.trim()
				.split('\n')
				.map((line: string) => `> ${line}`)
				.join('\n'),
		)
		.replace(/<[^>]*>/g, '');
	return decodeHtmlEntities(markdown)
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function extractRssFullContent(item: RSSItem): string {
	const raw = toPlainText(item['content:encoded']) || toPlainText(item.content) || toPlainText(item.description);
	if (!raw || raw.length < 800) return '';
	return htmlToMarkdown(raw);
}

function extractUrlFromItem(item: RSSItem): string | null {
	const directLink = asString(item.link);
	if (directLink) return directLink;

	const links = normalizeItems(item.link);
	const primaryLink =
		links.find((link) => (attr(link, 'rel') ?? 'alternate').toLowerCase() === 'alternate' && (attr(link, 'type') ?? '').includes('html')) ??
		links.find((link) => (attr(link, 'rel') ?? 'alternate').toLowerCase() === 'alternate') ??
		links[0];

	return (primaryLink ? attr(primaryLink, 'href') : undefined) ?? asString(item.url) ?? null;
}

function extractItemsFromFeed(data: unknown): RSSItem[] {
	const source =
		getPath(data, ['rss', 'channel', 'item']) ??
		getPath(data, ['feed', 'entry']) ??
		getPath(data, ['channel', 'item']) ??
		getPath(data, ['rdf:RDF', 'item']);
	return normalizeItems(source);
}

async function queueRssItem(env: Env, feed: RSSFeed, item: RSSItem, url: string): Promise<boolean> {
	let sourceType = 'rss';
	let platformMetadata: PlatformMetadata | null = null;
	const commentsUrl = toPlainText(item.comments) || undefined;
	if (commentsUrl) {
		try {
			platformMetadata = await resolveDiscussionPlatformMetadata(commentsUrl);
			sourceType = platformMetadata?.type ?? sourceType;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Failed to resolve discussion metadata', feed: feed.name, error: String(err) });
		}
	}

	let crawledContent = '';
	if (sourceType === 'rss') {
		const rssContent = extractRssFullContent(item);
		if (rssContent) {
			crawledContent = rssContent;
		} else {
			try {
				const scraped = await scrapeWebPage(url);
				crawledContent = scraped.content;
			} catch (e) {
				console.warn({ tag: 'RSS', msg: 'Scrape fallback failed', url, error: String(e) });
			}
		}
	}

	const pubDate = toPlainText(item.pubDate) || toPlainText(item.isoDate) || toPlainText(item.published) || toPlainText(item.updated);

	await startSourceArticleWorkflow(env, {
		article: {
			url,
			title: toPlainText(item.title) || toPlainText(item.text) || 'No Title',
			source: feed.name,
			publishedDate: pubDate ? new Date(pubDate) : new Date(),
			summary: platformMetadata ? '' : stripHtml(item.description ?? item.summary ?? ''),
			sourceType,
			content: crawledContent || null,
			ogImageUrl: null,
			platformMetadata,
		},
	});
	return true;
}

async function processFeed(env: Env, db: Client, feed: RSSFeed, parser: XMLParser): Promise<void> {
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

	let items = extractItemsFromFeed(parser.parse(await readTextWithLimit(res, MAX_FEED_BYTES)));
	if (!items.length) {
		console.info({ tag: 'RSS', msg: 'Feed has no items', feed: feed.name });
		await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
		return;
	}

	if (items.length > 30) items = items.slice(0, 30);

	const itemUrls: FeedItemWithUrl[] = [];
	for (const item of items) {
		const rawUrl = extractUrlFromItem(item);
		if (rawUrl) itemUrls.push({ item, url: normalizeUrl(rawUrl) });
	}
	const urls = itemUrls.map(({ url }) => url);
	const existingRecords = await getExistingArticlesByUrl(db, urls);
	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = itemUrls.filter(({ url }) => !existingSet.has(url));

	console.info({ tag: 'RSS', msg: 'Feed processed', feed: feed.name, newCount: newItems.length, totalCount: items.length });
	let queued = 0;
	for (const { item, url } of newItems) {
		try {
			if (await queueRssItem(env, feed, item, url)) queued++;
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Item enqueue failed, skipping', feed: feed.name, url, error: String(err) });
		}
	}
	console.info({ tag: 'RSS', msg: 'Feed enqueue done', feed: feed.name, queued, total: newItems.length });
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [new Date(), feed.id]);
}

export async function handleRSSCron(env: Env): Promise<void> {
	console.info({ tag: 'RSS', msg: 'start' });
	const parser = new XMLParser({ ignoreAttributes: false });
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const feeds = (await db.query<RSSFeed>(`SELECT ${SOURCE_FEED_FIELDS} FROM "RssList" WHERE is_default = true AND type = 'rss'`)).rows;
	for (const feed of feeds) {
		try {
			await processFeed(env, db, feed, parser);
		} catch (err) {
			console.warn({ tag: 'RSS', msg: 'Feed failed', feed: feed.name, error: String(err) });
		}
	}

	console.info({ tag: 'RSS', msg: 'end' });
}
