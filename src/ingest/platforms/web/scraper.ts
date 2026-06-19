// ─────────────────────────────────────────────────────────────
// Web Scraper (cheerio + Readability hybrid)
// ─────────────────────────────────────────────────────────────

import { Readability } from '@mozilla/readability';
import { BROWSER_UA, decodeHtmlEntities, fetchWithTimeout, readTextWithLimit, type ScrapedContent } from '@shared/web';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { cleanExtractedContent } from '../../domain/content-cleanup';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Filter out avatar/icon images by URL patterns and alt text */
function isJunkImage(src: string, alt?: string): boolean {
	const lower = src.toLowerCase();
	if (/[_/,](w|h|width|height)[_=]?\d{1,2}[,_/&]/.test(lower)) return true;
	if (/c_fill/.test(lower)) return true;
	if (/avatar|profile.?pic|favicon|icon|logo|badge|emoji/i.test(lower)) return true;
	if (alt && /avatar|profile|icon|logo/i.test(alt)) return true;
	return false;
}

interface ArticleMetadata {
	title: string;
	ogImageUrl: string | null;
	ogImageWidth: number | null;
	ogImageHeight: number | null;
	description: string | null;
	siteName: string;
	author: string | null;
	publishedDate: string | null;
}

/** Extract metadata from HTML using cheerio (og:tags, author, date, etc.) */
function extractMetadata($: cheerio.CheerioAPI, url: string): ArticleMetadata {
	const title =
		$('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content') || $('title').text() || '';

	let ogImageUrl =
		$('meta[property="og:image"]').attr('content')?.trim() ||
		$('meta[property="og:image:url"]').attr('content')?.trim() ||
		$('meta[name="twitter:image"]').attr('content')?.trim() ||
		null;

	if (ogImageUrl && !ogImageUrl.startsWith('http')) {
		try {
			ogImageUrl = new URL(ogImageUrl, url).toString();
		} catch {
			ogImageUrl = null;
		}
	}
	if (ogImageUrl && /^http:\/\//i.test(ogImageUrl)) {
		ogImageUrl = ogImageUrl.replace(/^http:/i, 'https:');
	}

	const rawW = $('meta[property="og:image:width"]').attr('content');
	const rawH = $('meta[property="og:image:height"]').attr('content');
	const ogImageWidth = rawW ? parseInt(rawW, 10) || null : null;
	const ogImageHeight = rawH ? parseInt(rawH, 10) || null : null;

	const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || null;
	const siteName = $('meta[property="og:site_name"]').attr('content') || new URL(url).hostname;
	const author = $('meta[name="author"]').attr('content') || $('meta[property="article:author"]').attr('content') || null;
	const publishedDate = $('meta[property="article:published_time"]').attr('content') || $('time').attr('datetime') || null;

	return { title: title.trim(), ogImageUrl, ogImageWidth, ogImageHeight, description, siteName, author, publishedDate };
}

type CheerioEl = ReturnType<cheerio.CheerioAPI>;

function renderImageMarkdown($img: CheerioEl, baseUrl: string): string | null {
	if ($img.hasClass('social-image') || $img.hasClass('navbar-logo') || $img.hasClass('avatar')) return null;
	let src = $img.attr('src') || $img.attr('data-src');
	if (!src) return null;
	if (!src.startsWith('http')) {
		try {
			src = new URL(src, baseUrl).href;
		} catch {
			return null;
		}
	}
	if (isJunkImage(src, $img.attr('alt') ?? undefined)) return null;
	return `![${$img.attr('alt') || 'Image'}](${src})\n\n`;
}

const TAG_HANDLERS: Record<string, ($el: CheerioEl, baseUrl: string) => string | null> = {
	p: ($el) => {
		const text = $el.text().trim();
		return text ? `${text}\n\n` : null;
	},
	h1: ($el) => `## ${$el.text().trim()}\n\n`,
	h2: ($el) => `### ${$el.text().trim()}\n\n`,
	h3: ($el) => `#### ${$el.text().trim()}\n\n`,
	h4: ($el) => `#### ${$el.text().trim()}\n\n`,
	img: renderImageMarkdown,
};

/** Extract article content using cheerio selectors (fallback method) */
function extractContentCheerio($: cheerio.CheerioAPI, title: string, url: string): string {
	$('script, style, nav, footer, header, aside, .ad, .advertisement, .social-share').remove();

	const candidates = [$('article').first(), $('main').first(), $('[role="main"]').first(), $('body')];
	const mainContent = candidates.find((el) => el.length > 0 && el.find('p, h1, h2, h3, h4').length > 0) ?? $('body');

	let content = `# ${title}\n\n`;
	const elements = mainContent.find('p, h1, h2, h3, h4, img');

	for (const el of elements) {
		const $el = $(el);
		const tag = ($el.prop('tagName') as string | undefined)?.toLowerCase();
		if (!tag) continue;
		const handler = TAG_HANDLERS[tag];
		if (!handler) continue;
		try {
			const fragment = handler($el, url);
			if (fragment) content += fragment;
		} catch (error) {
			console.warn({ tag: 'WEB', msg: 'Error processing element', error: String(error) });
		}
	}

	return content.trim();
}

/** Extract article content using Mozilla Readability + turndown (primary method) */
function extractContentReadability(html: string, url: string): string | null {
	try {
		// linkedom types parseHTML as `Window & typeof globalThis`, which doesn't
		// surface `document` under the Workers tsconfig (no DOM lib). Widen to read
		// it; Readability consumes the linkedom document at runtime.
		const { document } = parseHTML(html) as unknown as { document: object };
		const reader = new Readability(document, { charThreshold: 100 });
		const article = reader.parse();

		if (!article?.content) return null;

		// Resolve relative URLs in Readability output before converting to markdown.
		// parseHTML creates a document with no base URL, so Readability preserves
		// relative hrefs/srcs as-is. Load into cheerio to absolutify them.
		const $r = cheerio.load(article.content);
		try {
			const base = url;
			$r('a[href]').each((_, el) => {
				const href = $r(el).attr('href');
				if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) {
					try {
						$r(el).attr('href', new URL(href, base).href);
					} catch {}
				}
			});
			$r('img[src]').each((_, el) => {
				const src = $r(el).attr('src');
				if (src && !src.startsWith('http') && !src.startsWith('data:')) {
					try {
						$r(el).attr('src', new URL(src, base).href);
					} catch {}
				}
			});
		} catch {}

		const turndown = new TurndownService({
			headingStyle: 'atx',
			codeBlockStyle: 'fenced',
			bulletListMarker: '-',
		});
		// Remove empty links and script/style tags
		turndown.remove(['script', 'style']);

		const markdown = turndown.turndown($r('body').html() ?? article.content);
		if (!markdown || markdown.length < 50) return null;

		return markdown;
	} catch (error) {
		console.warn({ tag: 'WEB', msg: 'Readability extraction failed', url, error: String(error) });
		return null;
	}
}

/** Check if extracted content is essentially just a URL or title heading (low-quality extraction) */
function isLowQualityContent(content: string): boolean {
	const trimmed = content.trim();
	// Content is just a markdown heading with a URL
	if (/^#\s+https?:\/\/\S+\s*$/.test(trimmed)) return true;
	// Content is only a single heading line (title only, no body)
	const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);
	if (lines.length <= 1 && trimmed.length < 200) return true;
	return false;
}

const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export const HTML_FETCH_HEADERS: HeadersInit = {
	'User-Agent': BROWSER_UA,
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
};

/**
 * Parse HTML from an already-fetched Response into ScrapedContent. Used both
 * by `scrapeWebPage` (for the retry path) and by `registry.ts` (single-fetch
 * dispatch). Caller is responsible for verifying status + content-type before
 * handing over the response.
 */
export async function scrapeHtmlFromResponse(response: Response, url: string): Promise<ScrapedContent> {
	const contentLength = Number(response.headers.get('content-length') || '0');
	if (contentLength > MAX_HTML_BYTES) {
		throw new Error(`Response too large: ${contentLength} bytes`);
	}

	const finalUrl = response.url || url;

	const html = await readTextWithLimit(response, MAX_HTML_BYTES);
	const $ = cheerio.load(html);
	const metadata = extractMetadata($, finalUrl);

	const rawContent = extractContentReadability(html, finalUrl) ?? extractContentCheerio($, metadata.title, finalUrl);
	const content = cleanExtractedContent(rawContent);

	return {
		title: metadata.title,
		content,
		summary: metadata.description || undefined,
		ogImageUrl: metadata.ogImageUrl,
		ogImageWidth: metadata.ogImageWidth,
		ogImageHeight: metadata.ogImageHeight,
		siteName: metadata.siteName,
		author: metadata.author,
		publishedDate: metadata.publishedDate,
	};
}

async function fetchAndExtract(url: string): Promise<ScrapedContent & { finalUrl: string }> {
	const response = await fetchWithTimeout(url, { headers: HTML_FETCH_HEADERS }, FETCH_TIMEOUT_MS);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const contentType = response.headers.get('content-type') || '';
	if (!contentType.includes('text/html') && !contentType.includes('text/xml') && !contentType.includes('application/xhtml')) {
		await response.body?.cancel();
		throw new Error(`Non-HTML response: ${contentType}`);
	}

	const scraped = await scrapeHtmlFromResponse(response, url);
	return { ...scraped, finalUrl: response.url || url };
}

/** Collect candidate retry URLs when content extraction fails */
function getRetryUrls(inputUrl: string, finalUrl: string, content: string): string[] {
	const candidates = new Set<string>();

	// Strip query params from input URL
	const inputObj = new URL(inputUrl);
	if (inputObj.search) candidates.add(`${inputObj.origin}${inputObj.pathname}`);

	// Strip query params from final redirected URL
	if (finalUrl !== inputUrl) {
		const finalObj = new URL(finalUrl);
		if (finalObj.search) candidates.add(`${finalObj.origin}${finalObj.pathname}`);
		// Also add the final URL without query params even if it has none (different domain after redirect)
		if (!finalObj.search) candidates.add(finalUrl);
	}

	// Extract URL from content itself (e.g. when title is the redirect URL with query params)
	const urlMatch = content.match(/^#\s+(https?:\/\/\S+)/);
	if (urlMatch) {
		try {
			const embeddedObj = new URL(urlMatch[1]);
			candidates.add(`${embeddedObj.origin}${embeddedObj.pathname}`);
		} catch {
			/* ignore invalid URLs */
		}
	}

	// Remove the original input URL from candidates
	candidates.delete(inputUrl);
	return [...candidates];
}

export async function scrapeWebPage(url: string): Promise<ScrapedContent> {
	console.info({ tag: 'WEB', msg: 'Scraping', url });

	const result = await fetchAndExtract(url);

	// If content is low-quality, try one alternative URL (stripped query params / URL extracted from content)
	if (isLowQualityContent(result.content)) {
		const retryUrls = getRetryUrls(url, result.finalUrl, result.content);
		if (retryUrls.length > 0) {
			const retryUrl = retryUrls[0];
			console.info({ tag: 'WEB', msg: 'Low-quality content, retrying', url, retryUrl });
			try {
				const retryResult = await fetchAndExtract(retryUrl);
				if (!isLowQualityContent(retryResult.content) && retryResult.content.length > result.content.length) {
					console.info({ tag: 'WEB', msg: 'Retry succeeded', url: retryUrl, chars: retryResult.content.length });
					return retryResult;
				}
			} catch (err) {
				console.warn({ tag: 'WEB', msg: 'Retry failed', url: retryUrl, error: String(err) });
			}
		}
	}

	console.info({ tag: 'WEB', msg: 'Scraped', url, chars: result.content.length });

	return result;
}

// ─────────────────────────────────────────────────────────────
// Lightweight OG Image Fetcher
// ─────────────────────────────────────────────────────────────

const OG_FETCH_TIMEOUT_MS = 6_000;
// 128 KB. 32 KB was enough for the average <head>, but heavy news sites stuff
// JSON-LD, inline <style>, and analytics shims into the head and push og:image
// past that boundary. Facebook's own crawler uses Range 0-524288 (512 KB);
// 128 KB is the cheap middle ground that catches the long tail without paying
// for full-page downloads.
const OG_MAX_BYTES = 131_072;

export interface OgImageResult {
	ogImageUrl: string | null;
	ogImageWidth: number | null;
	ogImageHeight: number | null;
}

/**
 * Lightweight fetch of OG image metadata from a URL.
 * Only downloads the first ~32KB of HTML (enough for <head> meta tags)
 * instead of the full page. Returns null on any failure.
 */
export async function fetchOgImage(url: string): Promise<OgImageResult | null> {
	try {
		const response = await fetchWithTimeout(
			url,
			{
				headers: {
					'User-Agent': BROWSER_UA,
					Accept: 'text/html,application/xhtml+xml',
				},
			},
			OG_FETCH_TIMEOUT_MS,
		);

		if (!response.ok || !response.body) {
			await response.body?.cancel();
			return null;
		}

		// Read only the first chunk (enough for <head>)
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;

		while (totalBytes < OG_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			chunks.push(value);
			totalBytes += value.length;
		}
		await reader.cancel();

		const html = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : mergeChunks(chunks, totalBytes));

		// Parse meta tags from partial HTML
		let ogImageUrl = extractMeta(html, 'og:image') || extractMeta(html, 'og:image:url') || extractMetaName(html, 'twitter:image');
		if (!ogImageUrl) return null;

		if (!ogImageUrl.startsWith('http')) {
			try {
				ogImageUrl = new URL(ogImageUrl, url).toString();
			} catch {
				return null;
			}
		}
		if (/^http:\/\//i.test(ogImageUrl)) {
			ogImageUrl = ogImageUrl.replace(/^http:/i, 'https:');
		}

		const rawW = extractMeta(html, 'og:image:width');
		const rawH = extractMeta(html, 'og:image:height');

		return {
			ogImageUrl,
			ogImageWidth: rawW ? parseInt(rawW, 10) || null : null,
			ogImageHeight: rawH ? parseInt(rawH, 10) || null : null,
		};
	} catch {
		return null;
	}
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return merged;
}

function extractMeta(html: string, property: string): string | null {
	const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i');
	const raw = re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? null;
	// Always trim — scraped meta values (Substack's CDN URLs in particular)
	// can carry trailing whitespace that breaks downstream consumers like
	// next/image which throws on URLs with trailing spaces.
	return raw ? decodeHtmlEntities(raw).trim() || null : null;
}

function extractMetaName(html: string, name: string): string | null {
	const re = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
	const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i');
	const raw = re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? null;
	return raw ? decodeHtmlEntities(raw).trim() || null : null;
}
