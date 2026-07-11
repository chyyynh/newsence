import { fetchWithTimeout, readBytesWithLimit, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { canonicalizeOptionalResourceLang } from '@core-shared/resource-types';
import type { NormalizedContent, PdfExtractionMetadata } from '@core-shared/types';
import { extractFromHtml } from '@extractus/article-extractor';
import { decode } from 'html-entities';
import { type PdfTextArtifact, parsePdfBytes } from './platforms/pdf';

export const PDF_MIME = 'application/pdf';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_PDF_MAX_BYTES = 25 * 1024 * 1024;
const MIN_ARTICLE_CONTENT_CHARS = 180;
const OG_FETCH_TIMEOUT_MS = 6_000;
const OG_MAX_BYTES = 131_072;

type ExtractedHtmlArticle = {
	html: string;
	title: string | null;
	author: string | null;
	language: string | null;
	publishedDate: string | null;
	siteName: string | null;
	description: string | null;
};

function optionalText(value: string | undefined): string | null {
	return value?.trim() || null;
}

async function extractSupplementalMetadata(html: string): Promise<{ language: string | null; siteName: string | null }> {
	let language: string | null = null;
	let siteName: string | null = null;
	await new HTMLRewriter()
		.on('html[lang]', {
			element(element) {
				language ??= canonicalizeOptionalResourceLang(element.getAttribute('lang'));
			},
		})
		.on('meta[property="og:locale"]', {
			element(element) {
				language ??= canonicalizeOptionalResourceLang(element.getAttribute('content'));
			},
		})
		.on('meta[property="og:site_name"]', {
			element(element) {
				const content = element.getAttribute('content')?.trim();
				if (!siteName && content) siteName = decode(content).trim() || null;
			},
		})
		.transform(new Response(html))
		.arrayBuffer();
	return { language, siteName };
}

async function extractHtmlArticle(html: string, url: string): Promise<ExtractedHtmlArticle | null> {
	const [article, supplementalMetadata] = await Promise.all([
		extractFromHtml(html, url, { contentLengthThreshold: MIN_ARTICLE_CONTENT_CHARS }),
		extractSupplementalMetadata(html),
	]);
	if (!article?.content?.trim()) return null;

	return {
		html: article.content.trim(),
		title: optionalText(article.title),
		author: optionalText(article.author),
		language: supplementalMetadata.language,
		publishedDate: optionalText(article.published),
		siteName: supplementalMetadata.siteName ?? optionalText(article.source),
		description: optionalText(article.description),
	};
}

export type OgImagePatch = {
	ogImageUrl: string | null;
	ogImageWidth: number | null;
	ogImageHeight: number | null;
};

export type AcquiredWebContent = NormalizedContent<'web' | 'pdf'> & {
	extraction?: PdfExtractionMetadata;
	ogImage?: OgImagePatch;
};

export const EMPTY_OG_IMAGE_PATCH: OgImagePatch = {
	ogImageUrl: null,
	ogImageWidth: null,
	ogImageHeight: null,
};

function urlHost(url: string): string {
	return new URL(url).hostname.replace(/^www\./, '');
}

function fileNameFromUrl(url: string, fallback: string): string {
	const encodedName = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
	let name = encodedName;
	try {
		name = decodeURIComponent(encodedName);
	} catch {
		// Keep the encoded path segment when the source URL has malformed escapes.
	}
	return name || fallback;
}

function titleFromFileName(fileName: string): string {
	return fileName.replace(/\.[a-z0-9]+$/i, '').trim() || fileName;
}

export function pdfExtractionMetadata(pdf: PdfTextArtifact): PdfExtractionMetadata {
	return { status: pdf.status, parser: 'liteparse', chars: pdf.chars, pages: pdf.pages };
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
	return raw ? decode(raw).trim() || null : null;
}

function extractMetaName(html: string, name: string): string | null {
	const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i');
	const raw = re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? null;
	return raw ? decode(raw).trim() || null : null;
}

function extractOgImageFromHtml(html: string, url: string): OgImagePatch {
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
					'User-Agent': WEB_FETCH_USER_AGENT,
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
			const remaining = OG_MAX_BYTES - totalBytes;
			const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			chunks.push(chunk);
			totalBytes += chunk.byteLength;
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

function stripLeadingFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

async function markdownFromHtml(env: CoreEnv, html: string, url: string): Promise<string> {
	const result = await env.AI.toMarkdown(
		{
			name: fileNameFromUrl(url, `${urlHost(url)}.html`),
			blob: new Blob([html], { type: 'text/html' }),
		},
		{
			conversionOptions: { html: { hostname: new URL(url).hostname } },
		},
	);
	if (result.format === 'error') throw new Error(`Workers AI toMarkdown failed: ${result.error}`);
	return result.data.trim();
}

async function acquirePdfBytes(bytes: Uint8Array, url: string, fileName: string): Promise<AcquiredWebContent> {
	const parsed = await parsePdfBytes(bytes);
	const title = titleFromFileName(fileName) || 'PDF document';
	return {
		type: 'pdf',
		title,
		markdown: parsed.text,
		metadata: {
			author: null,
			language: null,
			publishedDate: null,
			siteName: urlHost(url),
			description: parsed.text.slice(0, 500) || null,
		},
		platformMetadata: {
			fetchedAt: new Date().toISOString(),
			data: { fileName, fileSize: bytes.byteLength },
		},
		extraction: pdfExtractionMetadata(parsed),
	};
}

async function acquirePdfResponse(url: string, response: Response): Promise<AcquiredWebContent> {
	const finalUrl = response.url || url;
	const bytes = await readBytesWithLimit(response, GENERIC_PDF_MAX_BYTES);
	return acquirePdfBytes(bytes, finalUrl, fileNameFromUrl(finalUrl, 'document.pdf'));
}

async function acquireHtmlArticle(env: CoreEnv, html: string, url: string, fileName: string): Promise<AcquiredWebContent> {
	const article = await extractHtmlArticle(html, url);
	if (!article) throw new Error(`No readable article content found: ${url}`);

	const markdown = await markdownFromHtml(env, article.html, url);
	const content = stripLeadingFrontmatter(markdown);
	if (content.length < MIN_ARTICLE_CONTENT_CHARS) {
		throw new Error(`Extracted HTML content is too short (${content.length} chars): ${url}`);
	}
	const title = article.title ?? titleFromMarkdown(markdown) ?? titleFromFileName(fileName);
	return {
		type: 'web',
		title,
		markdown: content,
		metadata: {
			author: article.author,
			language: article.language,
			publishedDate: article.publishedDate,
			siteName: article.siteName ?? urlHost(url),
			description: article.description,
		},
		platformMetadata: { fetchedAt: new Date().toISOString(), data: null },
		ogImage: extractOgImageFromHtml(html, url),
	};
}

export async function acquireWebResource(url: string, env: CoreEnv): Promise<AcquiredWebContent> {
	const response = await fetchWithTimeout(
		url,
		{
			headers: {
				'User-Agent': WEB_FETCH_USER_AGENT,
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
		return acquirePdfResponse(url, response);
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
	return acquireHtmlArticle(env, html, finalUrl, fileNameFromUrl(finalUrl, `${urlHost(finalUrl)}.html`));
}
