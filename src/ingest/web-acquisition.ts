import { fetchWithTimeout, readBytesWithLimit, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import type { NormalizedContent, PdfExtractionMetadata } from '@core-shared/types';
import { extractFromHtml } from '@extractus/article-extractor';
import { type PdfTextArtifact, parsePdfBytes } from './platforms/pdf';

export const PDF_MIME = 'application/pdf';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_PDF_MAX_BYTES = 25 * 1024 * 1024;
const MIN_ARTICLE_CONTENT_CHARS = 180;

type ExtractedHtmlArticle = {
	html: string;
	title: string | null;
	author: string | null;
	language: string | null;
	publishedDate: string | null;
	siteName: string | null;
	description: string | null;
	previewImageUrl: string | null;
};

function optionalText(value: string | undefined): string | null {
	return value?.trim() || null;
}

async function extractHtmlArticle(html: string, url: string): Promise<ExtractedHtmlArticle | null> {
	const article = await extractFromHtml(html, url, {
		contentLengthThreshold: MIN_ARTICLE_CONTENT_CHARS,
		descriptionLengthThreshold: 0,
	});
	if (!article?.content?.trim()) return null;

	return {
		html: article.content.trim(),
		title: optionalText(article.title),
		author: optionalText(article.author),
		language: null,
		publishedDate: optionalText(article.published),
		siteName: optionalText(article.source),
		description: optionalText(article.description),
		previewImageUrl: optionalText(article.image),
	};
}

export type AcquiredWebContent = NormalizedContent<'web' | 'pdf'> & {
	extraction?: PdfExtractionMetadata;
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
		previewImageUrl: article.previewImageUrl,
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
