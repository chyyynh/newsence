import { BROWSER_UA } from '../infra/fetch';
import { isRasterImage } from '../infra/mime';
import { assertExternalFetchable } from '../infra/web';
import { detectPlatformType, extractHackerNewsId, extractTweetId, extractYouTubeId, type ScrapedContent } from '../models/scraped-content';
import { scrapeHackerNews } from './hackernews/scraper';
import { scrapeTweet } from './twitter/scraper';
import { scrapeHtmlFromResponse } from './web/scraper';
import { scrapeYouTube } from './youtube/scraper';

export interface ScrapeOptions {
	youtubeApiKey?: string;
	kaitoApiKey?: string;
}

export type ScrapeResult =
	| { kind: 'page'; scraped: ScrapedContent }
	| {
			kind: 'blob';
			body: ReadableStream<Uint8Array>;
			contentType: string;
			sourceUrl: string;
			suggestedFilename: string;
			/** From upstream `Content-Length` — null if absent or unparseable. */
			contentLength: number | null;
			dispose: () => void;
	  };

const PDF_MIME = 'application/pdf';
const DISPATCH_TIMEOUT_MS = 8_000;

// Content-neutral headers for the dispatch fetch. Accept: */* avoids tripping
// CDN content-negotiation that would otherwise serve an HTML interstitial when
// the URL is actually a PDF or image. Routing is decided from the response's
// Content-Type, not from what we asked for.
const DISPATCH_HEADERS: HeadersInit = {
	'User-Agent': BROWSER_UA,
	Accept: '*/*',
	'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
};

function isHtmlLike(ct: string): boolean {
	return ct.includes('text/html') || ct.includes('text/xml') || ct.includes('application/xhtml');
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

function filenameFromUrl(url: string, fallback: string): string {
	try {
		const tail = new URL(url).pathname.split('/').filter(Boolean).pop();
		return tail || fallback;
	} catch {
		return fallback;
	}
}

/**
 * Single-fetch dispatch for arbitrary external URLs. The Response's headers
 * tell us whether to parse as HTML or stream as a blob; non-supported types
 * cancel the body and throw. Saves a subrequest vs HEAD-probe, and lets blob
 * paths stream directly to R2 without buffering.
 *
 * Timer scope: the AbortController stays armed through HTML body parsing and
 * blob streaming so a stalled origin can't hang the read. Blob callers must
 * call dispose() after R2 consumes or abandons the stream.
 *
 * `scrapeWebPage` intentionally keeps a separate HTML fetch path for the
 * low-quality extraction retry behavior used by monitor flows.
 */
async function fetchAndDispatch(url: string): Promise<ScrapeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
	let releaseTimer = true;
	const dispose = () => {
		clearTimeout(timer);
		controller.abort();
	};
	try {
		const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: DISPATCH_HEADERS });
		if (!res.ok) {
			await res.body?.cancel();
			throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		}

		const ct = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream';

		if (isHtmlLike(ct)) {
			const scraped = await scrapeHtmlFromResponse(res, url);
			return { kind: 'page', scraped };
		}

		if (ct === PDF_MIME || isRasterImage(ct)) {
			if (!res.body) throw new Error('Response body is empty');
			const lenRaw = res.headers.get('content-length');
			const contentLength = lenRaw ? Number.parseInt(lenRaw, 10) || null : null;
			const finalUrl = res.url || url;
			const cdName = parseContentDisposition(res.headers.get('content-disposition'));
			const suggestedFilename = cdName ?? filenameFromUrl(finalUrl, ct === PDF_MIME ? 'document.pdf' : 'image');
			releaseTimer = false;
			return { kind: 'blob', body: res.body, contentType: ct, sourceUrl: finalUrl, suggestedFilename, contentLength, dispose };
		}

		await res.body?.cancel();
		throw new Error(`Unsupported content-type: ${ct}`);
	} finally {
		if (releaseTimer) clearTimeout(timer);
	}
}

export async function scrapeUrl(url: string, options: ScrapeOptions): Promise<ScrapeResult> {
	const platformType = detectPlatformType(url);

	switch (platformType) {
		case 'youtube': {
			const videoId = extractYouTubeId(url);
			if (!videoId) throw new Error('Invalid YouTube URL');
			if (!options.youtubeApiKey) throw new Error('YouTube API key required');
			return { kind: 'page', scraped: await scrapeYouTube(videoId, options.youtubeApiKey) };
		}

		case 'twitter': {
			const tweetId = extractTweetId(url);
			if (!tweetId) throw new Error('Invalid Twitter URL');
			if (!options.kaitoApiKey) throw new Error('Kaito API key required');
			return { kind: 'page', scraped: await scrapeTweet(tweetId, options.kaitoApiKey) };
		}

		case 'hackernews': {
			const itemId = extractHackerNewsId(url);
			if (!itemId) throw new Error('Invalid HackerNews URL');
			return { kind: 'page', scraped: await scrapeHackerNews(itemId) };
		}

		default:
			assertExternalFetchable(url);
			return fetchAndDispatch(url);
	}
}
