import type { NormalizedContent } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, readTextWithLimit } from '@core-shared/web';

const READER_ENDPOINT = 'https://r.jina.ai/';
const READER_FETCH_TIMEOUT_MS = 30_000;
const RENDERED_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
const MIN_RENDERED_CONTENT_LENGTH = 200;

export type RenderedWebContent = NormalizedContent<'web'> & {
	ogImage: {
		ogImageUrl: string | null;
		ogImageWidth: number | null;
		ogImageHeight: number | null;
	};
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPositiveInt(value: unknown): number | null {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sourceHost(url: string): string {
	return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

function fallbackTitle(url: string): string {
	const encoded = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? sourceHost(url);
	try {
		return decodeURIComponent(encoded).replace(/[-_]+/g, ' ').trim() || sourceHost(url);
	} catch {
		return encoded.replace(/[-_]+/g, ' ').trim() || sourceHost(url);
	}
}

function readerUrl(url: string): string {
	const source = new URL(url);
	source.hash = '';
	return `${READER_ENDPOINT}${source.toString()}`;
}

function validatedContent(value: unknown, provider: string): string {
	const content = readString(value);
	if (!content || content.length < MIN_RENDERED_CONTENT_LENGTH) {
		throw new Error(`${provider} returned no usable content`);
	}
	return content;
}

async function renderUrlWithBrowserRun(url: string, env: CoreEnv): Promise<string> {
	const response = await env.BROWSER.quickAction('content', {
		url,
		gotoOptions: { waitUntil: 'networkidle2', timeout: 30_000 },
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Browser Run returned HTTP ${response.status}`);
	}

	const payload = JSON.parse(await readTextWithLimit(response, RENDERED_CONTENT_MAX_BYTES)) as unknown;
	const record = asRecord(payload);
	return validatedContent(record?.result, 'Browser Run');
}

async function scrapeUrlWithReader(url: string): Promise<RenderedWebContent> {
	const response = await fetchWithTimeout(
		readerUrl(url),
		{
			headers: {
				Accept: 'application/json',
				'User-Agent': FEED_UA,
			},
		},
		READER_FETCH_TIMEOUT_MS,
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Reader fallback returned HTTP ${response.status}`);
	}

	const payload = JSON.parse(await readTextWithLimit(response, RENDERED_CONTENT_MAX_BYTES)) as unknown;
	const data = asRecord(asRecord(payload)?.data);
	const metadata = asRecord(data?.metadata);
	const markdown = validatedContent(data?.content, 'Reader fallback');

	return {
		type: 'web',
		title: readString(data?.title) ?? fallbackTitle(url),
		markdown,
		metadata: {
			author: readString(metadata?.author),
			language: readString(metadata?.lang),
			publishedDate: readString(data?.publishedTime),
			siteName: readString(metadata?.['og:site_name']) ?? sourceHost(url),
			description: readString(data?.description) ?? readString(metadata?.description),
		},
		platformMetadata: {
			fetchedAt: new Date().toISOString(),
			data: null,
		},
		ogImage: {
			ogImageUrl: readString(metadata?.['og:image']),
			ogImageWidth: readPositiveInt(metadata?.['og:image:width']),
			ogImageHeight: readPositiveInt(metadata?.['og:image:height']),
		},
	};
}

export async function scrapeUrlWithRenderedContent(
	url: string,
	env: CoreEnv,
	fromRenderedHtml: (html: string) => Promise<RenderedWebContent>,
): Promise<RenderedWebContent> {
	try {
		return await fromRenderedHtml(await renderUrlWithBrowserRun(url, env));
	} catch (browserError) {
		console.warn({
			tag: 'WEB',
			msg: 'Browser Run acquisition failed; trying external reader',
			url,
			error: String(browserError),
		});
		try {
			return await scrapeUrlWithReader(url);
		} catch (readerError) {
			throw new Error(`Rendered acquisition failed: ${String(browserError)}; ${String(readerError)}`);
		}
	}
}
