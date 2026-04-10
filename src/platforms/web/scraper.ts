// ─────────────────────────────────────────────────────────────
// Web Scraper (cheerio + Readability hybrid) + Unified Scraper
// ─────────────────────────────────────────────────────────────

import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { logInfo, logWarn } from '../../infra/log';
import { cleanExtractedContent } from '../../domain/content-cleanup';
import { detectPlatformType, extractHackerNewsId, extractTweetId, extractYouTubeId, type ScrapedContent } from '../../models/scraped-content';
import { scrapeHackerNews } from '../hackernews/scraper';
import { scrapeTweet } from '../twitter/scraper';
import { scrapeYouTube } from '../youtube/scraper';

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

/** Extract article content using cheerio selectors (fallback method) */
function extractContentCheerio($: cheerio.CheerioAPI, title: string, url: string): string {
	$('script, style, nav, footer, header, aside, .ad, .advertisement, .social-share').remove();

	const candidates = [$('article').first(), $('main').first(), $('[role="main"]').first(), $('body')];
	const mainContent = candidates.find((el) => el.length > 0 && el.find('p, h1, h2, h3, h4').length > 0) ?? $('body');

	let content = `# ${title}\n\n`;
	const elements = mainContent.find('p, h1, h2, h3, h4, img');

	for (const el of elements) {
		try {
			const element = $(el);
			if (element.is('p')) {
				const text = element.text().trim();
				if (text.length > 0) content += `${text}\n\n`;
			} else if (element.is('h1')) {
				content += `## ${element.text().trim()}\n\n`;
			} else if (element.is('h2')) {
				content += `### ${element.text().trim()}\n\n`;
			} else if (element.is('h3') || element.is('h4')) {
				content += `#### ${element.text().trim()}\n\n`;
			} else if (element.is('img')) {
				if (element.hasClass('social-image') || element.hasClass('navbar-logo') || element.hasClass('avatar')) continue;
				let imgSrc = element.attr('src') || element.attr('data-src');
				if (imgSrc && !imgSrc.startsWith('http')) {
					try {
						imgSrc = new URL(imgSrc, url).href;
					} catch {
						continue;
					}
				}
				if (!imgSrc || isJunkImage(imgSrc, element.attr('alt') ?? undefined)) continue;
				content += `![${element.attr('alt') || 'Image'}](${imgSrc})\n\n`;
			}
		} catch (error) {
			logWarn('WEB', 'Error processing element', { error: String(error) });
		}
	}

	return content.trim();
}

/** Extract article content using Mozilla Readability + turndown (primary method) */
function extractContentReadability(html: string, url: string): string | null {
	try {
		const { document } = parseHTML(html);
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
		logWarn('WEB', 'Readability extraction failed', { url, error: String(error) });
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

async function fetchAndExtract(url: string): Promise<ScrapedContent & { finalUrl: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	const response = await fetch(url, {
		headers: {
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
		},
		signal: controller.signal,
	});

	if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

	const contentType = response.headers.get('content-type') || '';
	if (!contentType.includes('text/html') && !contentType.includes('text/xml') && !contentType.includes('application/xhtml')) {
		throw new Error(`Non-HTML response: ${contentType}`);
	}

	const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
	const contentLength = Number(response.headers.get('content-length') || '0');
	if (contentLength > MAX_BODY_BYTES) {
		throw new Error(`Response too large: ${contentLength} bytes`);
	}

	const finalUrl = response.url || url;

	// Stream the body with a hard byte cap to guard against chunked responses
	// or origins that omit/lie about Content-Length.
	// Keep the abort timer active until the body is fully read — a stalled
	// origin that sends headers quickly but trickles the body would otherwise
	// hang until the Worker's own timeout.
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		reader = response.body!.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > MAX_BODY_BYTES) {
				reader.cancel();
				throw new Error(`Response body exceeded ${MAX_BODY_BYTES} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		clearTimeout(timer);
	}
	const merged = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const html = new TextDecoder().decode(merged);
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
		finalUrl,
	};
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
	logInfo('WEB', 'Scraping', { url });

	const result = await fetchAndExtract(url);

	// If content is low-quality, try one alternative URL (stripped query params / URL extracted from content)
	if (isLowQualityContent(result.content)) {
		const retryUrls = getRetryUrls(url, result.finalUrl, result.content);
		if (retryUrls.length > 0) {
			const retryUrl = retryUrls[0];
			logInfo('WEB', 'Low-quality content, retrying', { url, retryUrl });
			try {
				const retryResult = await fetchAndExtract(retryUrl);
				if (!isLowQualityContent(retryResult.content) && retryResult.content.length > result.content.length) {
					logInfo('WEB', 'Retry succeeded', { url: retryUrl, chars: retryResult.content.length });
					return retryResult;
				}
			} catch (err) {
				logWarn('WEB', 'Retry failed', { url: retryUrl, error: String(err) });
			}
		}
	}

	logInfo('WEB', 'Scraped', { url, chars: result.content.length });

	return result;
}

// ─────────────────────────────────────────────────────────────
// Unified Scraper
// ─────────────────────────────────────────────────────────────

export interface ScrapeOptions {
	youtubeApiKey?: string;
	kaitoApiKey?: string;
}

export async function scrapeUrl(url: string, options: ScrapeOptions): Promise<ScrapedContent> {
	const platformType = detectPlatformType(url);

	switch (platformType) {
		case 'youtube': {
			const videoId = extractYouTubeId(url);
			if (!videoId) throw new Error('Invalid YouTube URL');
			if (!options.youtubeApiKey) throw new Error('YouTube API key required');
			return scrapeYouTube(videoId, options.youtubeApiKey);
		}

		case 'twitter': {
			const tweetId = extractTweetId(url);
			if (!tweetId) throw new Error('Invalid Twitter URL');
			if (!options.kaitoApiKey) throw new Error('Kaito API key required');
			return scrapeTweet(tweetId, options.kaitoApiKey);
		}

		case 'hackernews': {
			const itemId = extractHackerNewsId(url);
			if (!itemId) throw new Error('Invalid HackerNews URL');
			return scrapeHackerNews(itemId);
		}

		default:
			return scrapeWebPage(url);
	}
}

// ─────────────────────────────────────────────────────────────
// Lightweight OG Image Fetcher
// ─────────────────────────────────────────────────────────────

const OG_FETCH_TIMEOUT_MS = 6_000;
const OG_MAX_BYTES = 32_768; // 32 KB — enough for <head>

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
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OG_FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				Accept: 'text/html,application/xhtml+xml',
			},
			signal: controller.signal,
		});

		if (!response.ok || !response.body) return null;

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
		reader.cancel();

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

		const rawW = extractMeta(html, 'og:image:width');
		const rawH = extractMeta(html, 'og:image:height');

		return {
			ogImageUrl,
			ogImageWidth: rawW ? parseInt(rawW, 10) || null : null,
			ogImageHeight: rawH ? parseInt(rawH, 10) || null : null,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
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

function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, '/');
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
