import { isRasterImage, PDF_MIME } from '@core-shared/mime';
import type { ExtractedContent } from '@core-shared/types';
import { BROWSER_UA, detectUrlKind } from '@core-shared/web';
import { extractHackerNewsId, scrapeHackerNews } from './platforms/hackernews/scraper';
import { extractTweetId, scrapeTweet } from './platforms/twitter/scraper';
import { scrapeHtmlFromResponse } from './platforms/web-scraper';
import { extractYouTubeId, scrapeYouTube } from './platforms/youtube/scraper';

export type ScrapeResult =
	| { kind: 'page'; scraped: ExtractedContent }
	| {
			kind: 'asset';
			body: ReadableStream<Uint8Array>;
			contentType: string;
			sourceUrl: string;
			suggestedFilename: string;
			/** From upstream `Content-Length` — null if absent or unparseable. */
			contentLength: number | null;
	  };

const GENERIC_URL_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_URL_FETCH_HEADERS: HeadersInit = {
	'User-Agent': BROWSER_UA,
	Accept: '*/*',
	'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
};

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

async function fetchGenericUrl(url: string): Promise<ScrapeResult> {
	const res = await fetch(url, {
		redirect: 'follow',
		signal: AbortSignal.timeout(GENERIC_URL_FETCH_TIMEOUT_MS),
		headers: GENERIC_URL_FETCH_HEADERS,
	});
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`HTTP ${res.status}: ${res.statusText}`);
	}

	const ct = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? 'application/octet-stream';

	if (ct.includes('text/html') || ct.includes('text/xml') || ct.includes('application/xhtml')) {
		const scraped = await scrapeHtmlFromResponse(res, url);
		return { kind: 'page', scraped };
	}

	if (ct === PDF_MIME || isRasterImage(ct)) {
		if (!res.body) throw new Error('Response body is empty');
		const lenRaw = res.headers.get('content-length');
		const contentLength = lenRaw ? Number.parseInt(lenRaw, 10) || null : null;
		const finalUrl = res.url || url;
		const cdName = parseContentDisposition(res.headers.get('content-disposition'));
		const suggestedFilename =
			cdName ?? new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? (ct === PDF_MIME ? 'document.pdf' : 'image');
		return { kind: 'asset', body: res.body, contentType: ct, sourceUrl: finalUrl, suggestedFilename, contentLength };
	}

	await res.body?.cancel();
	throw new Error(`Unsupported content-type: ${ct}`);
}

export async function scrapeUrl(url: string, options: { youtubeApiKey?: string; kaitoApiKey?: string }): Promise<ScrapeResult> {
	switch (detectUrlKind(url)) {
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
		case 'web':
			break;
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('Invalid URL');
	}
	if (parsed.protocol !== 'https:') throw new Error('Only https:// URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');
	return fetchGenericUrl(url);
}
