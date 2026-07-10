import type { NormalizedContent } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, readTextWithLimit } from '@core-shared/web';

const READER_ENDPOINT = 'https://r.jina.ai/';
const READER_FETCH_TIMEOUT_MS = 30_000;
const READER_MAX_BYTES = 5 * 1024 * 1024;
const MIN_READER_CONTENT_LENGTH = 200;

export type ReaderAcquiredContent = NormalizedContent<'web'> & {
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

export async function scrapeUrlWithReader(url: string): Promise<ReaderAcquiredContent> {
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

	const payload = JSON.parse(await readTextWithLimit(response, READER_MAX_BYTES)) as unknown;
	const data = asRecord(asRecord(payload)?.data);
	const metadata = asRecord(data?.metadata);
	const markdown = readString(data?.content);
	if (!markdown || markdown.length < MIN_READER_CONTENT_LENGTH) {
		throw new Error('Reader fallback returned no usable content');
	}

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
