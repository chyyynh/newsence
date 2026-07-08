import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { isRasterImage, MAGIC_SNIFF_BYTES, PDF_MIME, sniffMediaType } from '@core-shared/mime';
import type { ExtractedContent, ScrapedContent } from '@core-shared/types';
import { BROWSER_UA, detectUrlKind, MAX_UPLOAD_BYTES, streamWithByteLimit } from '@core-shared/web';
import { extractHackerNewsId, scrapeHackerNews } from './platforms/hackernews/scraper';
import { parsePdf } from './platforms/pdf';
import { extractTweetId, scrapeTweet } from './platforms/twitter/scraper';
import { scrapeHtmlFromResponse } from './platforms/web-scraper';
import { extractYouTubeId, scrapeYouTube } from './platforms/youtube/scraper';

export const SCRAPE_INPUT_TEMP_PREFIX = 'tmp/scrape/';

export type ExtractInput = { kind: 'url'; url: string } | { kind: 'r2'; key: string };

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
	  };

const EMPTY_METADATA: ExtractedContent['metadata'] = {
	author: null,
	publishedDate: null,
	siteName: null,
	description: null,
	ogImageUrl: null,
};

type ParsedPdf = Awaited<ReturnType<typeof parsePdf>>;

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
		return { kind: 'blob', body: res.body, contentType: ct, sourceUrl: finalUrl, suggestedFilename, contentLength };
	}

	await res.body?.cancel();
	throw new Error(`Unsupported content-type: ${ct}`);
}

export async function scrapeUrl(url: string, options: ScrapeOptions): Promise<ScrapeResult> {
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

function stripMarkdown(md: string): string {
	return md
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/(\*\*|__|\*|_|`)/g, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function normalizeHtml(scraped: ScrapedContent, sourceUrl: string | null): ExtractedContent {
	const markdown = scraped.markdown ?? '';
	return {
		...scraped,
		sourceUrl,
		markdown,
		text: stripMarkdown(markdown),
		status: markdown.trim().length > 0 ? 'ok' : 'failed',
	};
}

function normalizePdf(parsed: ParsedPdf, sourceUrl: string | null): ExtractedContent {
	return {
		sourceUrl,
		contentType: PDF_MIME,
		title: null,
		markdown: parsed.text,
		text: parsed.text,
		metadata: { ...EMPTY_METADATA, pages: parsed.pages, chars: parsed.chars },
		status: parsed.status,
	};
}

export async function extractFile(bytes: Uint8Array): Promise<ExtractedContent> {
	const type = sniffMediaType(bytes.subarray(0, MAGIC_SNIFF_BYTES)) ?? 'application/octet-stream';
	if (type === PDF_MIME) return normalizePdf(await parsePdf(bytes), null);
	return { sourceUrl: null, contentType: type, title: null, markdown: '', text: '', metadata: { ...EMPTY_METADATA }, status: 'failed' };
}

export async function extractUrl(env: Env, url: string): Promise<ExtractedContent> {
	const result = await scrapeUrl(url, { youtubeApiKey: env.YOUTUBE_API_KEY, kaitoApiKey: env.KAITO_API_KEY });
	if (result.kind === 'page') return normalizeHtml(result.scraped, url);

	if (result.contentType === PDF_MIME) {
		const limited = streamWithByteLimit(result.body, MAX_UPLOAD_BYTES);
		const bytes = new Uint8Array(await new Response(limited).arrayBuffer());
		return normalizePdf(await parsePdf(bytes), result.sourceUrl);
	}
	await result.body.cancel();
	return {
		sourceUrl: result.sourceUrl,
		contentType: result.contentType,
		title: null,
		markdown: '',
		text: '',
		metadata: { ...EMPTY_METADATA },
		status: 'failed',
	};
}

export async function extractSource(env: Env, input: ExtractInput): Promise<ExtractedContent> {
	switch (input.kind) {
		case 'url':
			return extractUrl(env, input.url);
		case 'r2': {
			if (!input.key.startsWith(SCRAPE_INPUT_TEMP_PREFIX)) throw new Error(`Invalid scrape input temp object key: ${input.key}`);
			const obj = await env.R2.get(input.key);
			if (!obj) throw new Error(`scrape input temp object missing: ${input.key}`);
			return extractFile(await obj.bytes());
		}
	}
}

// Non-persisting scrape job. Unlike NewsenceMonitorWorkflow this creates no DB
// row; callers poll the Workflow output for ExtractedContent.
export class ScrapeWorkflow extends WorkflowEntrypoint<Env, ExtractInput> {
	async run(event: WorkflowEvent<ExtractInput>, step: WorkflowStep): Promise<ExtractedContent> {
		const input = event.payload;

		const result = await step.do(
			'extract',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			() => extractSource(this.env, input),
		);

		if (input.kind === 'r2' && input.key.startsWith(SCRAPE_INPUT_TEMP_PREFIX)) {
			await step.do('cleanup', { retries: { limit: 2, delay: '5 seconds' }, timeout: '15 seconds' }, () => this.env.R2.delete(input.key));
		}

		console.info({ tag: 'SCRAPE_WORKFLOW', msg: 'Completed', kind: input.kind, status: result.status, chars: result.metadata.chars });
		return result;
	}
}
