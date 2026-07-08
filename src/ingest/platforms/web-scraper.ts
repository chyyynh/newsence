import type { NormalizedContent, PlatformMetadata } from '@core-shared/types';
import { FEED_UA, fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { Readability } from '@mozilla/readability';
import * as cheerio from 'cheerio';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { parsePdfBytes } from './pdf';

const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

const FETCH_HEADERS: HeadersInit = {
	'User-Agent': FEED_UA,
	Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
	'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
};

interface ArticleMetadata {
	title: string;
	description: string | null;
	siteName: string;
	author: string | null;
	publishedDate: string | null;
}

type CheerioEl = ReturnType<cheerio.CheerioAPI>;

function extractMetadata($: cheerio.CheerioAPI, url: string): ArticleMetadata {
	const title =
		$('meta[property="og:title"]').attr('content') || $('meta[name="twitter:title"]').attr('content') || $('title').text() || '';
	const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || null;
	const siteName = $('meta[property="og:site_name"]').attr('content') || new URL(url).hostname.replace(/^www\./, '');
	const author = $('meta[name="author"]').attr('content') || $('meta[property="article:author"]').attr('content') || null;
	const publishedDate = $('meta[property="article:published_time"]').attr('content') || $('time').attr('datetime') || null;
	return { title: title.trim(), description, siteName, author, publishedDate };
}

function isJunkImage(src: string, alt?: string): boolean {
	const lower = src.toLowerCase();
	if (/[_/,](w|h|width|height)[_=]?\d{1,2}[,_/&]/.test(lower)) return true;
	if (/c_fill/.test(lower)) return true;
	if (/avatar|profile.?pic|favicon|icon|logo|badge|emoji/i.test(lower)) return true;
	if (alt && /avatar|profile|icon|logo/i.test(alt)) return true;
	return false;
}

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
	for (const el of mainContent.find('p, h1, h2, h3, h4, img')) {
		const $el = $(el);
		const tag = ($el.prop('tagName') as string | undefined)?.toLowerCase();
		const fragment = tag ? TAG_HANDLERS[tag]?.($el, url) : null;
		if (fragment) content += fragment;
	}
	return content.trim();
}

function extractContentReadability(html: string, url: string): string | null {
	try {
		const { document } = parseHTML(html) as unknown as { document: object };
		const article = new Readability(document, { charThreshold: 100 }).parse();
		if (!article?.content) return null;

		const $readable = cheerio.load(article.content);
		for (const el of $readable('a[href]')) {
			const href = $readable(el).attr('href');
			if (href && !href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) {
				try {
					$readable(el).attr('href', new URL(href, url).href);
				} catch {}
			}
		}
		for (const el of $readable('img[src]')) {
			const src = $readable(el).attr('src');
			if (src && !src.startsWith('http') && !src.startsWith('data:')) {
				try {
					$readable(el).attr('src', new URL(src, url).href);
				} catch {}
			}
		}

		const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
		turndown.remove(['script', 'style']);
		const markdown = turndown.turndown($readable('body').html() ?? article.content).trim();
		return markdown.length >= 50 ? markdown : null;
	} catch (error) {
		console.warn({ tag: 'WEB', msg: 'Readability extraction failed', url, error: String(error) });
		return null;
	}
}

async function scrapeHtmlFromResponse(response: Response, url: string): Promise<NormalizedContent> {
	const html = await readTextWithLimit(response, MAX_HTML_BYTES);
	const finalUrl = response.url || url;
	const $ = cheerio.load(html);
	const metadata = extractMetadata($, finalUrl);
	const title = metadata.title || new URL(finalUrl).hostname.replace(/^www\./, '');
	return {
		title,
		markdown: extractContentReadability(html, finalUrl) ?? extractContentCheerio($, title, finalUrl),
		metadata,
	};
}

function pdfFileName(url: string): string {
	try {
		const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '');
		return name || new URL(url).hostname;
	} catch {
		return 'document.pdf';
	}
}

async function scrapePdfFromResponse(response: Response, url: string): Promise<NormalizedContent> {
	const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
	if (contentLength > MAX_PDF_BYTES) throw new Error(`PDF response too large: ${contentLength} bytes`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_PDF_BYTES) throw new Error(`PDF response exceeded ${MAX_PDF_BYTES} bytes`);
	const parsed = await parsePdfBytes(bytes);
	const title = pdfFileName(response.url || url).replace(/\.pdf$/i, '') || 'PDF document';
	const platformMetadata: Extract<PlatformMetadata, { type: 'pdf' }> = {
		type: 'pdf',
		fetchedAt: new Date().toISOString(),
		data: { fileName: pdfFileName(response.url || url), fileSize: bytes.byteLength },
	};
	return {
		title,
		markdown: parsed.text,
		metadata: {
			author: null,
			publishedDate: null,
			siteName: new URL(response.url || url).hostname.replace(/^www\./, ''),
			description: parsed.text.slice(0, 500) || null,
		},
		platformMetadata,
	};
}

export async function scrapeWebPage(url: string): Promise<NormalizedContent> {
	console.info({ tag: 'WEB', msg: 'Scraping', url });
	const response = await fetchWithTimeout(url, { headers: FETCH_HEADERS }, FETCH_TIMEOUT_MS);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const contentType = response.headers.get('content-type') || '';
	const isPdf = contentType.includes('application/pdf');
	const isHtml =
		!contentType ||
		contentType.includes('text/html') ||
		contentType.includes('text/xml') ||
		contentType.includes('application/xhtml') ||
		contentType.includes('application/xml');
	if (!isPdf && !isHtml) {
		await response.body?.cancel();
		throw new Error(`Unsupported response content type: ${contentType}`);
	}

	const result = isPdf ? await scrapePdfFromResponse(response, url) : await scrapeHtmlFromResponse(response, url);
	console.info({ tag: 'WEB', msg: 'Scraped', url, chars: result.markdown.length });
	return result;
}
