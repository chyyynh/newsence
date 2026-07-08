import type { NormalizedContent } from '@core-shared/types';
import { BROWSER_UA, fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

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
	description: string | null;
	siteName: string;
	author: string | null;
	publishedDate: string | null;
}

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

	const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || null;
	const siteName = $('meta[property="og:site_name"]').attr('content') || new URL(url).hostname;
	const author = $('meta[name="author"]').attr('content') || $('meta[property="article:author"]').attr('content') || null;
	const publishedDate = $('meta[property="article:published_time"]').attr('content') || $('time').attr('datetime') || null;

	return { title: title.trim(), ogImageUrl, description, siteName, author, publishedDate };
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
		turndown.remove(['script', 'style']);

		const markdown = turndown.turndown($r('body').html() ?? article.content);
		if (!markdown || markdown.length < 50) return null;

		return markdown;
	} catch (error) {
		console.warn({ tag: 'WEB', msg: 'Readability extraction failed', url, error: String(error) });
		return null;
	}
}

const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

const HTML_FETCH_HEADERS: HeadersInit = {
	'User-Agent': BROWSER_UA,
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
	'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
};

async function scrapeHtmlFromResponse(response: Response, url: string): Promise<NormalizedContent> {
	const contentLength = Number(response.headers.get('content-length') || '0');
	if (contentLength > MAX_HTML_BYTES) {
		throw new Error(`Response too large: ${contentLength} bytes`);
	}

	const finalUrl = response.url || url;

	const html = await readTextWithLimit(response, MAX_HTML_BYTES);
	const $ = cheerio.load(html);
	const metadata = extractMetadata($, finalUrl);

	const content = extractContentReadability(html, finalUrl) ?? extractContentCheerio($, metadata.title, finalUrl);

	return {
		sourceUrl: finalUrl,
		title: metadata.title,
		markdown: content,
		metadata: {
			author: metadata.author,
			publishedDate: metadata.publishedDate,
			siteName: metadata.siteName,
			description: metadata.description,
			ogImageUrl: metadata.ogImageUrl,
		},
	};
}

async function fetchAndExtract(url: string): Promise<NormalizedContent> {
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

	return scrapeHtmlFromResponse(response, url);
}

export async function scrapeWebPage(url: string): Promise<NormalizedContent> {
	console.info({ tag: 'WEB', msg: 'Scraping', url });

	const result = await fetchAndExtract(url);
	console.info({ tag: 'WEB', msg: 'Scraped', url, chars: result.markdown.length });
	return result;
}
