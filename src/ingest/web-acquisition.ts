import { coreAiRequestOptions, throwCoreAiError } from '@core-ai/generation';
import { fetchWithTimeout, readBytesWithLimit, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import type { NormalizedContent, PdfExtractionMetadata } from '@core-shared/types';
import { normalizePreviewImageUrl } from '@core-shared/url';
import { addTransformations, extractFromHtml } from '@extractus/article-extractor';
import { arxivHtmlUrl } from './platforms/paper';
import { type PdfTextArtifact, parsePdfBytes } from './platforms/pdf';

export const PDF_MIME = 'application/pdf';

const GENERIC_FETCH_TIMEOUT_MS = 8_000;
const GENERIC_HTML_MAX_BYTES = 5 * 1024 * 1024;
const GENERIC_PDF_MAX_BYTES = 25 * 1024 * 1024;
const MIN_ARTICLE_CONTENT_CHARS = 180;

type TransformElement = {
	parentElement: TransformElement | null;
	removeAttribute(name: string): void;
};

// Direct saved LessWrong URLs still use web acquisition. RSS sources in feed mode never reach this transformation.
addTransformations({
	patterns: [/^https:\/\/(?:www\.)?lesswrong\.com\/posts\//],
	pre(document) {
		// article-extractor relies on the ambient DOM Document type, while Workers
		// exposes a different global Document in service-binding consumers.
		const postContent = (
			document as typeof document & {
				querySelector(selector: string): TransformElement | null;
			}
		).querySelector('.PostsPage-postContent');
		let container = postContent?.parentElement;
		while (container) {
			container.removeAttribute('hidden');
			container = container.parentElement;
		}
		return document;
	},
});

type ExtractedHtmlArticle = {
	html: string;
	title: string;
	author: string | null;
	language: string | null;
	publishedDate: string | null;
	siteName: string;
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
	const title = article.title?.trim();
	if (!title) throw new Error(`Extracted article has no title: ${url}`);
	const siteName = article.source?.trim();
	if (!siteName) throw new Error(`Extracted article has no source: ${url}`);

	return {
		html: article.content.trim(),
		title,
		author: optionalText(article.author),
		language: null,
		publishedDate: optionalText(article.published),
		siteName,
		description: optionalText(article.description),
		previewImageUrl: article.image ? normalizePreviewImageUrl(article.image, url) : null,
	};
}

export type AcquiredWebContent = NormalizedContent<null> & {
	extraction?: PdfExtractionMetadata;
};

function urlHost(url: string): string {
	return new URL(url).hostname.replace(/^www\./, '');
}

function fileNameFromUrl(url: string): string {
	const encodedName = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
	if (!encodedName) return 'document.pdf';
	try {
		return decodeURIComponent(encodedName) || 'document.pdf';
	} catch {
		return encodedName;
	}
}

function titleFromFileName(fileName: string): string {
	const title = fileName.replace(/\.[a-z0-9]+$/i, '').trim();
	if (!title) throw new Error(`File name has no title: ${fileName}`);
	return title;
}

export function pdfExtractionMetadata(pdf: PdfTextArtifact): PdfExtractionMetadata {
	return { status: pdf.status, parser: 'liteparse', chars: pdf.chars, pages: pdf.pages };
}

function stripLeadingFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

export async function markdownFromHtml(env: CoreEnv, html: string, url: string, resourceId?: string): Promise<string> {
	const context = { feature: 'html-to-markdown', resourceId };
	let result: ConversionResponse;
	try {
		result = await env.AI.toMarkdown(
			{
				name: `${urlHost(url)}.html`,
				blob: new Blob([html], { type: 'text/html' }),
			},
			{
				...coreAiRequestOptions(env, context),
				conversionOptions: { html: { hostname: new URL(url).hostname } },
			},
		);
	} catch (error) {
		throwCoreAiError(env, error, { ...context, model: 'workers-ai/to-markdown' });
	}
	// The error variant has no structured status, so its message cannot identify a rate limit.
	if (result.format === 'error') throw new Error(`Workers AI toMarkdown failed: ${result.error}`);
	return stripLeadingFrontmatter(result.data);
}

async function acquirePdfBytes(bytes: Uint8Array, url: string, fileName: string): Promise<AcquiredWebContent> {
	const parsed = await parsePdfBytes(bytes);
	const title = titleFromFileName(fileName);
	return {
		kind: 'blog',
		resourcePlatform: null,
		fileType: PDF_MIME,
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
			data: null,
			representation: { fileName, fileSize: bytes.byteLength },
		},
		extraction: pdfExtractionMetadata(parsed),
	};
}

async function acquirePdfResponse(response: Response, finalUrl: string): Promise<AcquiredWebContent> {
	const bytes = await readBytesWithLimit(response, GENERIC_PDF_MAX_BYTES);
	return acquirePdfBytes(bytes, finalUrl, fileNameFromUrl(finalUrl));
}

async function acquireHtmlArticle(env: CoreEnv, html: string, url: string, resourceId?: string): Promise<AcquiredWebContent> {
	const article = await extractHtmlArticle(html, url);
	if (!article) throw new Error(`No readable article content found: ${url}`);

	const content = await markdownFromHtml(env, article.html, url, resourceId);
	if (content.length < MIN_ARTICLE_CONTENT_CHARS) {
		throw new Error(`Extracted HTML content is too short (${content.length} chars): ${url}`);
	}
	return {
		kind: 'blog',
		resourcePlatform: null,
		fileType: null,
		title: article.title,
		markdown: content,
		metadata: {
			author: article.author,
			language: article.language,
			publishedDate: article.publishedDate,
			siteName: article.siteName,
			description: article.description,
		},
		platformMetadata: { fetchedAt: new Date().toISOString(), data: null },
		previewImageUrl: article.previewImageUrl,
	};
}

function articleRequestInit(): RequestInit {
	return {
		headers: {
			'User-Agent': WEB_FETCH_USER_AGENT,
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
			'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
		},
	};
}

// The LaTeXML rendering is an upgrade, never a requirement: arXiv answers 200
// for papers it has not rendered, and a thin or unparseable page must not turn
// a resource that the abs page would have acquired into a failed one. Any
// problem here falls through to the caller's original URL.
async function tryAcquireArxivHtml(htmlUrl: string, env: CoreEnv, resourceId?: string): Promise<AcquiredWebContent | null> {
	try {
		const response = await fetchWithTimeout(htmlUrl, articleRequestInit(), GENERIC_FETCH_TIMEOUT_MS);
		const finalUrl = response.url.trim();
		if (!response.ok || !finalUrl || !new URL(finalUrl).pathname.startsWith('/html/')) {
			await response.body?.cancel();
			return null;
		}
		const html = await readTextWithLimit(response, GENERIC_HTML_MAX_BYTES);
		return await acquireHtmlArticle(env, html, finalUrl, resourceId);
	} catch {
		return null;
	}
}

export async function acquireWebResource(url: string, env: CoreEnv, resourceId?: string): Promise<AcquiredWebContent> {
	const htmlUrl = arxivHtmlUrl(url);
	if (htmlUrl && htmlUrl !== url) {
		const rendered = await tryAcquireArxivHtml(htmlUrl, env, resourceId);
		if (rendered) return rendered;
	}

	const response = await fetchWithTimeout(url, articleRequestInit(), GENERIC_FETCH_TIMEOUT_MS);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	const finalUrl = response.url.trim();
	if (!finalUrl) {
		await response.body?.cancel();
		throw new Error(`Fetch response has no final URL: ${url}`);
	}

	const contentType = response.headers.get('content-type')?.toLowerCase() || '';
	if (contentType.includes(PDF_MIME) || new URL(finalUrl).pathname.toLowerCase().endsWith('.pdf')) {
		return acquirePdfResponse(response, finalUrl);
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

	const html = await readTextWithLimit(response, GENERIC_HTML_MAX_BYTES);
	return acquireHtmlArticle(env, html, finalUrl, resourceId);
}
