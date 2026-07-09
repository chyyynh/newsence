import type { NormalizedContent } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, readBytesWithLimit, readTextWithLimit } from '@core-shared/web';
import { extractReadableArticleHtml, preferReadableArticleText } from '@ingest/html-content';
import { type PdfTextArtifact, parsePdfBytes } from './pdf';

export const PDF_MIME = 'application/pdf';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_PDF_MAX_BYTES = 25 * 1024 * 1024;
const OG_FETCH_TIMEOUT_MS = 6_000;
const OG_MAX_BYTES = 131_072;

export type PdfExtractionMetadata = {
	status: PdfTextArtifact['status'];
	parser: 'liteparse';
	chars: number;
	pages: number;
};

export type OgImagePatch = {
	ogImageUrl: string | null;
	ogImageWidth: number | null;
	ogImageHeight: number | null;
};

export type WebAcquiredContent = NormalizedContent & {
	extraction?: PdfExtractionMetadata;
	ogImage?: OgImagePatch;
};

export const EMPTY_OG_IMAGE_PATCH: OgImagePatch = {
	ogImageUrl: null,
	ogImageWidth: null,
	ogImageHeight: null,
};

type HtmlMetadata = NormalizedContent['metadata'] & { title: string | null };

function urlHost(url: string): string {
	return new URL(url).hostname.replace(/^www\./, '');
}

function fileNameFromUrl(url: string, fallback: string): string {
	const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '');
	return name || fallback;
}

export function pdfExtractionMetadata(pdf: PdfTextArtifact): PdfExtractionMetadata {
	return { status: pdf.status, parser: 'liteparse', chars: pdf.chars, pages: pdf.pages };
}

function metaContentHandler(assign: (value: string) => void): HTMLRewriterElementContentHandlers {
	return {
		element(element) {
			const content = element.getAttribute('content')?.trim();
			if (content) assign(content);
		},
	};
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

async function extractHtmlMetadata(html: string, url: string): Promise<HtmlMetadata> {
	let titleText = '';
	let title: string | null = null;
	let description: string | null = null;
	let siteName: string | null = null;
	let author: string | null = null;
	let publishedDate: string | null = null;
	const setOnce = (set: (value: string) => void, current: () => string | null) => (value: string) => {
		if (!current()) set(value);
	};

	let rewriter = new HTMLRewriter().on('title', {
		text(text) {
			titleText += text.text;
		},
	});
	for (const [selector, assign, current] of [
		['meta[property="og:title"]', (value: string) => (title = value), () => title],
		['meta[name="twitter:title"]', (value: string) => (title = value), () => title],
		['meta[property="og:description"]', (value: string) => (description = value), () => description],
		['meta[name="description"]', (value: string) => (description = value), () => description],
		['meta[property="og:site_name"]', (value: string) => (siteName = value), () => siteName],
		['meta[name="author"]', (value: string) => (author = value), () => author],
		['meta[property="article:author"]', (value: string) => (author = value), () => author],
		['meta[property="article:published_time"]', (value: string) => (publishedDate = value), () => publishedDate],
	] as const) {
		rewriter = rewriter.on(selector, metaContentHandler(setOnce(assign, current)));
	}

	await rewriter
		.on('time[datetime]', {
			element(element) {
				if (!publishedDate) publishedDate = element.getAttribute('datetime')?.trim() || null;
			},
		})
		.transform(new Response(html))
		.arrayBuffer();

	const clean = (value: string | null): string | null => {
		const decoded = value ? decodeHtmlEntities(value).trim() : '';
		return decoded || null;
	};

	return {
		title: clean(title) ?? clean(titleText),
		author: clean(author),
		publishedDate: clean(publishedDate),
		siteName: clean(siteName) ?? urlHost(url),
		description: clean(description),
	};
}

function parsePositiveInt(raw: string | null): number | null {
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	return parsed > 0 ? parsed : null;
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

function extractMeta(html: string, property: string): string | null {
	const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i');
	const raw = re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? null;
	return raw ? decodeHtmlEntities(raw).trim() || null : null;
}

function extractMetaName(html: string, name: string): string | null {
	const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i');
	const raw = re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? null;
	return raw ? decodeHtmlEntities(raw).trim() || null : null;
}

export function extractOgImageFromHtml(html: string, url: string): OgImagePatch {
	let ogImageUrl = extractMeta(html, 'og:image') || extractMeta(html, 'og:image:url') || extractMetaName(html, 'twitter:image');
	if (!ogImageUrl) return EMPTY_OG_IMAGE_PATCH;

	try {
		ogImageUrl = new URL(ogImageUrl, url).toString();
	} catch {
		return EMPTY_OG_IMAGE_PATCH;
	}
	if (ogImageUrl.startsWith('http://')) ogImageUrl = ogImageUrl.replace(/^http:/, 'https:');

	return {
		ogImageUrl,
		ogImageWidth: parsePositiveInt(extractMeta(html, 'og:image:width')),
		ogImageHeight: parsePositiveInt(extractMeta(html, 'og:image:height')),
	};
}

export async function fetchOgImage(url: string): Promise<OgImagePatch> {
	try {
		const response = await fetchWithTimeout(
			url,
			{
				headers: {
					'User-Agent': FEED_UA,
					Accept: 'text/html,application/xhtml+xml',
				},
			},
			OG_FETCH_TIMEOUT_MS,
		);
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			return EMPTY_OG_IMAGE_PATCH;
		}

		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (totalBytes < OG_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			chunks.push(value);
			totalBytes += value.byteLength;
		}
		await reader.cancel();

		const html = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : mergeChunks(chunks, totalBytes));
		return extractOgImageFromHtml(html, url);
	} catch {
		return EMPTY_OG_IMAGE_PATCH;
	}
}

function titleFromMarkdown(markdown: string): string | null {
	return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
}

async function markdownFromHtml(env: CoreEnv, html: string, url: string): Promise<string> {
	const result = await env.AI.toMarkdown({
		name: fileNameFromUrl(url, `${urlHost(url)}.html`),
		blob: new Blob([html], { type: 'text/html' }),
	});
	if (result.format === 'error') throw new Error(`Workers AI toMarkdown failed: ${result.error}`);
	return result.data.trim();
}

async function scrapePdfUrl(url: string, response: Response): Promise<WebAcquiredContent> {
	const bytes = await readBytesWithLimit(response, GENERIC_PDF_MAX_BYTES);
	const parsed = await parsePdfBytes(bytes);
	const fileName = fileNameFromUrl(response.url || url, 'document.pdf');
	const title = fileName.replace(/\.pdf$/i, '') || 'PDF document';
	return {
		title,
		markdown: parsed.text,
		metadata: {
			author: null,
			publishedDate: null,
			siteName: urlHost(response.url || url),
			description: parsed.text.slice(0, 500) || null,
		},
		platformMetadata: {
			type: 'pdf',
			fetchedAt: new Date().toISOString(),
			data: { fileName, fileSize: bytes.byteLength },
		},
		extraction: pdfExtractionMetadata(parsed),
	};
}

export async function scrapeGenericUrl(url: string, env: CoreEnv): Promise<WebAcquiredContent> {
	const response = await fetchWithTimeout(
		url,
		{
			headers: {
				'User-Agent': FEED_UA,
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
				'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
			},
		},
		GENERIC_FETCH_TIMEOUT_MS,
	);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || new URL(response.url || url).pathname.toLowerCase().endsWith('.pdf')) {
		return scrapePdfUrl(url, response);
	}
	if (
		contentType &&
		!contentType.includes('text/html') &&
		!contentType.includes('text/xml') &&
		!contentType.includes('application/xhtml') &&
		!contentType.includes('application/xml')
	) {
		await response.body?.cancel();
		throw new Error(`Unsupported response content type: ${contentType}`);
	}

	const finalUrl = response.url || url;
	const html = await readTextWithLimit(response, GENERIC_HTML_MAX_BYTES);
	const [metadata, readable] = await Promise.all([extractHtmlMetadata(html, finalUrl), extractReadableArticleHtml(html)]);
	const markdown = await markdownFromHtml(env, readable?.html ?? html, finalUrl);
	const content = preferReadableArticleText(markdown, readable);
	const title = metadata.title ?? titleFromMarkdown(markdown) ?? urlHost(finalUrl);
	return {
		title,
		markdown: content,
		metadata: {
			author: metadata.author,
			publishedDate: metadata.publishedDate,
			siteName: metadata.siteName,
			description: metadata.description,
		},
		platformMetadata: { type: 'default', fetchedAt: new Date().toISOString(), data: null },
		ogImage: extractOgImageFromHtml(html, finalUrl),
	};
}
