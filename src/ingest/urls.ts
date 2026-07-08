import type { NormalizedContent } from '@core-shared/types';
import { BROWSER_UA, detectUrlKind, normalizeUrl } from '@core-shared/web';
import { getExistingUrlUserFile, insertScrapedUrlUserFile } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import { Client } from 'pg';
import { extractHackerNewsId, scrapeHackerNews } from './platforms/hackernews/scraper';
import { extractTweetId, scrapeTweet } from './platforms/twitter/scraper';
import { scrapeHtmlFromResponse } from './platforms/web-scraper';
import { extractYouTubeId, scrapeYouTube } from './platforms/youtube/scraper';

const INGEST_MAX_BATCH_SIZE = 20;
const INGEST_URL_CONCURRENCY = 4;
const URL_FETCH_TIMEOUT_MS = 8_000;
const PDF_MIME = 'application/pdf';
const URL_FETCH_HEADERS: HeadersInit = {
	'User-Agent': BROWSER_UA,
	Accept: '*/*',
	'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
};

type UrlFetchResult =
	| { kind: 'page'; scraped: NormalizedContent }
	| {
			kind: 'asset';
			body: ReadableStream<Uint8Array>;
			contentType: string;
			sourceUrl: string;
			suggestedFilename: string;
			contentLength: number | null;
	  };

type ExistingUrlUserFile = NonNullable<Awaited<ReturnType<typeof getExistingUrlUserFile>>>;

type IngestResult = {
	url: string;
	userFileId?: string;
	instanceId?: string;
	title?: string;
	titleCn?: string;
	summaryCn?: string;
	tags?: string[];
	ogImageUrl?: string | null;
	resourceKind?: 'url' | 'blob';
	originType?: 'saved_url';
	platformType?: string;
	fileType?: string;
	asset?: Extract<UrlFetchResult, { kind: 'asset' }>;
	alreadyExists?: boolean;
	error?: string;
};

function isRasterImage(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return lower.startsWith('image/') && !lower.startsWith('image/svg');
}

function parseContentDisposition(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/filename\*=UTF-8''([^;]+)|filename=("([^"]+)"|([^;]+))/i);
	const raw = match?.[1] ?? match?.[3] ?? match?.[4];
	if (!raw) return null;
	try {
		return decodeURIComponent(raw.trim());
	} catch {
		return raw.trim();
	}
}

async function fetchGenericUrlContent(url: string): Promise<UrlFetchResult> {
	const res = await fetch(url, {
		redirect: 'follow',
		signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
		headers: URL_FETCH_HEADERS,
	});
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`HTTP ${res.status}: ${res.statusText}`);
	}

	const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream';

	if (contentType.includes('text/html') || contentType.includes('text/xml') || contentType.includes('application/xhtml')) {
		return { kind: 'page', scraped: await scrapeHtmlFromResponse(res, url) };
	}

	if (contentType === PDF_MIME || isRasterImage(contentType)) {
		if (!res.body) throw new Error('Response body is empty');
		const lenRaw = res.headers.get('content-length');
		const contentLength = lenRaw ? Number.parseInt(lenRaw, 10) || null : null;
		const finalUrl = res.url || url;
		const cdName = parseContentDisposition(res.headers.get('content-disposition'));
		const suggestedFilename =
			cdName ?? new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? (contentType === PDF_MIME ? 'document.pdf' : 'image');
		return { kind: 'asset', body: res.body, contentType, sourceUrl: finalUrl, suggestedFilename, contentLength };
	}

	await res.body?.cancel();
	throw new Error(`Unsupported content-type: ${contentType}`);
}

async function fetchUrlContent(url: string, env: Env): Promise<UrlFetchResult> {
	switch (detectUrlKind(url)) {
		case 'youtube': {
			const videoId = extractYouTubeId(url);
			if (!videoId) throw new Error('Invalid YouTube URL');
			return { kind: 'page', scraped: await scrapeYouTube(videoId, env.YOUTUBE_API_KEY) };
		}
		case 'twitter': {
			const tweetId = extractTweetId(url);
			if (!tweetId) throw new Error('Invalid Twitter URL');
			return { kind: 'page', scraped: await scrapeTweet(tweetId, env.KAITO_API_KEY) };
		}
		case 'hackernews': {
			const itemId = extractHackerNewsId(url);
			if (!itemId) throw new Error('Invalid HackerNews URL');
			return { kind: 'page', scraped: await scrapeHackerNews(itemId) };
		}
		case 'web':
			break;
	}

	const parsed = new URL(url);
	if (parsed.protocol !== 'https:') throw new Error('Only https:// URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');
	return fetchGenericUrlContent(url);
}

function buildUserFileResult(
	url: string,
	row: {
		id: string;
		title: string;
		title_cn: string | null;
		summary_cn: string | null;
		tags: string[] | null;
		platform_type: string | null;
		og_image_url: string | null;
	},
	args: { instanceId?: string; alreadyExists: boolean; resourceKind?: 'url' | 'blob' },
): IngestResult {
	const resourceKind = args.resourceKind ?? 'url';
	const result: IngestResult = {
		url,
		userFileId: row.id,
		instanceId: args.instanceId,
		resourceKind,
		originType: 'saved_url',
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags ?? undefined,
		ogImageUrl: row.og_image_url,
		alreadyExists: args.alreadyExists,
	};
	if (resourceKind === 'url') result.platformType = row.platform_type || 'web';
	return result;
}

async function returnExisting(db: Client, url: string, row: ExistingUrlUserFile, env: Env): Promise<IngestResult> {
	const instanceId =
		row.title_cn && row.summary_cn && row.has_embedding
			? undefined
			: await enqueueProcessing(env, { kind: 'userFile', userFileId: row.id }, { db });
	return buildUserFileResult(url, row, { instanceId, alreadyExists: true, resourceKind: row.resource_kind === 'blob' ? 'blob' : 'url' });
}

async function processUrl(db: Client, url: string, env: Env, userId: string): Promise<IngestResult> {
	const existingRow = await getExistingUrlUserFile(db, userId, url);
	if (existingRow) {
		return returnExisting(db, url, existingRow, env);
	}

	let fetched: UrlFetchResult;
	try {
		fetched = await fetchUrlContent(url, env);
	} catch (err) {
		console.error({ tag: 'INGEST', msg: 'Scrape failed', url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}

	if (fetched.kind === 'asset') {
		return {
			url,
			resourceKind: 'blob',
			originType: 'saved_url',
			fileType: fetched.contentType,
			asset: fetched,
			alreadyExists: false,
		};
	}

	const inserted = await insertScrapedUrlUserFile(db, fetched.scraped, url, userId);
	if (!inserted.ok) return { url, error: inserted.error };

	const { row } = inserted;
	const instanceId = row.created
		? await enqueueProcessing(
				env,
				{
					kind: 'userFile',
					userFileId: row.id,
					youtubeTranscript: fetched.scraped.youtubeTranscript,
				},
				{ db },
			)
		: undefined;
	return buildUserFileResult(url, row, { instanceId, alreadyExists: !row.created });
}

export async function ingestUrls(
	env: Env,
	args: { urls: string[]; userId?: string },
): Promise<
	| { ok: true; results: IngestResult[] }
	| { ok: false; code: 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED'; message: string }
> {
	if (!args.userId) {
		return { ok: false, code: 'UNAUTHORIZED', message: 'userId is required' };
	}
	if (args.urls.length === 0) {
		return { ok: false, code: 'BAD_REQUEST', message: 'Missing urls field' };
	}
	if (args.urls.length > INGEST_MAX_BATCH_SIZE) {
		return {
			ok: false,
			code: 'BATCH_TOO_LARGE',
			message: `Maximum ${INGEST_MAX_BATCH_SIZE} URLs per request, got ${args.urls.length}`,
		};
	}

	const normalizedUrls = args.urls.map(normalizeUrl);
	const uniqueUrls = [...new Set(normalizedUrls)];

	console.info({ tag: 'INGEST', msg: 'Processing URLs', count: args.urls.length, uniqueCount: uniqueUrls.length, userId: args.userId });
	const userId = args.userId;
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	try {
		const uniqueResults: IngestResult[] = [];
		for (let i = 0; i < uniqueUrls.length; i += INGEST_URL_CONCURRENCY) {
			const batch = uniqueUrls.slice(i, i + INGEST_URL_CONCURRENCY);
			uniqueResults.push(...(await Promise.all(batch.map((url) => processUrl(db, url, env, userId)))));
		}
		const resultByUrl = new Map(uniqueResults.map((result) => [result.url, result]));
		const results = normalizedUrls.map((url) => resultByUrl.get(url) ?? { url, error: 'lost during fan-out' });
		return { ok: true, results };
	} finally {
		await db.end();
	}
}
