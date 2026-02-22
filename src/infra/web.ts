import * as cheerio from 'cheerio';
import { logWarn } from './log';

// ─────────────────────────────────────────────────────────────
// URL Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Resolves shortened URLs (t.co, bit.ly, etc.) to their final destination
 */
export async function resolveUrl(url: string): Promise<string> {
	try {
		const response = await fetch(url, {
			method: 'HEAD',
			redirect: 'follow',
		});
		return response.url;
	} catch {
		return url;
	}
}

/**
 * Checks if a URL is a social media link (should not follow)
 */
export function isSocialMediaUrl(url: string): boolean {
	const socialDomains = ['twitter.com', 'x.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'threads.net'];
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return socialDomains.some((d) => hostname.includes(d));
	} catch {
		return false;
	}
}

/**
 * Extracts title from HTML content
 */
export function extractTitleFromHtml(html: string): string | null {
	try {
		const $ = cheerio.load(html);
		return $('title').text().trim() || $('h1').first().text().trim() || null;
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────
// OG Image Extraction
// ─────────────────────────────────────────────────────────────

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function resolveRelativeUrl(src: string, base: string): string | null {
	const normalized = src.trim();
	if (!normalized) return null;
	if (/^https?:\/\//i.test(normalized)) return normalized;
	try {
		return new URL(normalized, base).toString();
	} catch {
		return null;
	}
}

/**
 * Extracts Open Graph image URL from a webpage
 */
export async function extractOgImage(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, {
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsenceBot/1.0)' },
		});
		if (!response.ok) return null;

		const html = await response.text();
		const $ = cheerio.load(html);

		const imageUrl =
			$('meta[property="og:image"]').attr('content') ||
			$('meta[property="og:image:url"]').attr('content') ||
			$('meta[name="twitter:image"]').attr('content') ||
			$('meta[name="twitter:image:src"]').attr('content') ||
			null;

		if (!imageUrl) return null;
		return resolveRelativeUrl(imageUrl, url);
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		logWarn('OG-IMAGE', 'Failed', { url, error: msg });
		return null;
	}
}

// ─────────────────────────────────────────────────────────────
// URL Normalization
// ─────────────────────────────────────────────────────────────

const TRACKING_PARAMS = [
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_content',
	'utm_term',
	'ref',
	'fbclid',
	'gclid',
	'mc_eid',
	'mc_cid',
	'access_token',
	'token',
	'auth_token',
	'api_key',
	'_',
	'__',
	'nc',
	'cachebust',
	'noCache',
	'cache',
	'rand',
	'random',
	'_rnd',
	'_refresh',
	'_t',
	'_ts',
	'_dc',
	'_q',
	'_nocache',
	'timestamp',
	'ts',
	'time',
	'cb',
	'r',
	'sid',
	'ttl',
	'vfff',
	'ttt',
];

/**
 * Normalizes URL by removing tracking, auth, and cache-busting parameters
 */
export function normalizeUrl(url: string): string {
	try {
		const urlObj = new URL(url);
		for (const param of TRACKING_PARAMS) urlObj.searchParams.delete(param);
		urlObj.searchParams.sort();
		return urlObj.toString();
	} catch {
		return url;
	}
}

// ─────────────────────────────────────────────────────────────
// Article Content Scraping
// ─────────────────────────────────────────────────────────────

function processHtmlElement($: cheerio.CheerioAPI, el: Parameters<cheerio.CheerioAPI>[0], baseUrl: string): string {
	const element = $(el);
	if (element.is('p')) return element.text().trim() + '\n\n';
	if (element.is('h1')) return `## ${element.text().trim()}\n\n`;
	if (element.is('h2')) return `### ${element.text().trim()}\n\n`;
	if (element.is('h3')) return `#### ${element.text().trim()}\n\n`;

	if (element.is('img')) {
		const skipClasses = ['social-image', 'navbar-logo'];
		if (skipClasses.some((cls) => element.hasClass(cls))) return '';
		const imgSrc = resolveRelativeUrl(element.attr('src') || '', baseUrl);
		if (imgSrc) return `![Image](${imgSrc})\n\n`;
	}

	return '';
}

export async function scrapeArticleContent(url: string): Promise<string> {
	try {
		const response = await fetch(url, {
			headers: { 'User-Agent': BROWSER_UA },
		});
		if (!response.ok) {
			logWarn('RSS-SCRAPER', 'HTTP error', { status: response.status, url });
			return '';
		}

		const html = await response.text();
		const $ = cheerio.load(html);
		const title = $('title').text();
		let content = `# ${title}\n\n`;

		for (const el of $('p, img, h1, h2, h3')) {
			content += processHtmlElement($, el, url);
		}

		return content.trim();
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		logWarn('RSS-SCRAPER', 'Failed to scrape', { url, error: msg });
		return '';
	}
}
