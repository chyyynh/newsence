// ─────────────────────────────────────────────────────────────
// Web Scraper (Playwright-based, JS-rendered)
// Session reuse via acquire() + connect() pattern
// ─────────────────────────────────────────────────────────────

import type { Browser } from '@cloudflare/playwright';
import { acquire, connect, sessions } from '@cloudflare/playwright';
import type { ScrapedContent } from '../domain/scrapers';
import { logInfo } from './log';

const KEEP_ALIVE_MS = 600_000; // 10 minutes

/**
 * Get a browser by reusing an existing idle session or acquiring a new one.
 * Always uses connect() so that browser.close() disconnects without killing the session.
 */
async function getOrCreateBrowser(binding: Fetcher): Promise<{ browser: Browser; reused: boolean }> {
	const active = await sessions(binding);
	const free = active.filter((s) => !s.connectionId);

	// Try connecting to a random free session
	if (free.length > 0) {
		const pick = free[Math.floor(Math.random() * free.length)];
		try {
			const browser = await connect(binding, pick.sessionId);
			return { browser, reused: true };
		} catch {
			// Session may have expired between listing and connecting — fall through to acquire
		}
	}

	// No free session (or connect failed) — acquire a new one, then connect
	const { sessionId } = await acquire(binding, { keep_alive: KEEP_ALIVE_MS });
	const browser = await connect(binding, sessionId);
	return { browser, reused: false };
}

// Extracts all metadata + content in a single CDP round-trip.
// Written as a plain JS string to avoid Workers TS environment lacking DOM types.
const EXTRACT_ALL_SCRIPT = /* js */ `
(() => {
	var getMeta = function(sel) {
		var el = document.querySelector(sel);
		return el ? el.getAttribute('content') : null;
	};

	var title = getMeta('meta[property="og:title"]') || getMeta('meta[name="twitter:title"]') || document.title || '';
	var ogImageUrl = getMeta('meta[property="og:image"]') || getMeta('meta[property="og:image:url"]') || getMeta('meta[name="twitter:image"]') || null;
	var description = getMeta('meta[property="og:description"]') || getMeta('meta[name="description"]') || null;
	var siteName = getMeta('meta[property="og:site_name"]') || location.hostname;
	var author = getMeta('meta[name="author"]') || getMeta('meta[property="article:author"]') || null;
	var timeEl = document.querySelector('time');
	var publishedDate = getMeta('meta[property="article:published_time"]') || (timeEl ? timeEl.getAttribute('datetime') : null);

	document.querySelectorAll(
		'script, style, nav, footer, header, aside, .ad, .advertisement, .social-share, .sidebar, .related-posts, .comments, [role="complementary"], [role="navigation"]'
	).forEach(function(el) { el.remove(); });

	var main =
		document.querySelector('article') ||
		document.querySelector('main') ||
		document.querySelector('[role="main"]') ||
		document.body;

	var blocks = [];
	main.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, img').forEach(function(el) {
		var tag = el.tagName.toLowerCase();
		if (tag === 'img') {
			var src = el.src || (el.dataset && el.dataset.src);
			var alt = el.alt || 'Image';
			if (!src || !src.startsWith('http')) return;
			var lower = src.toLowerCase();
			if (/[_/,](w|h|width|height)[_=]?\\d{1,2}[,_/&]/.test(lower)) return;
			if (/c_fill/.test(lower)) return;
			if (/avatar|profile.?pic|favicon|icon|logo|badge|emoji/i.test(lower)) return;
			if (/avatar|profile|icon|logo/i.test(alt)) return;
			blocks.push('![' + alt + '](' + src + ')');
		} else if (tag.charAt(0) === 'h') {
			var level = Math.min(parseInt(tag.charAt(1)) + 1, 6);
			var text = el.innerText && el.innerText.trim();
			if (text) blocks.push('#'.repeat(level) + ' ' + text);
		} else if (tag === 'blockquote') {
			var text = el.innerText && el.innerText.trim();
			if (text) blocks.push('> ' + text);
		} else if (tag === 'pre') {
			var text = el.innerText && el.innerText.trim();
			if (text) blocks.push('\\x60\\x60\\x60\\n' + text + '\\n\\x60\\x60\\x60');
		} else if (tag === 'li') {
			var text = el.innerText && el.innerText.trim();
			if (text) blocks.push('- ' + text);
		} else {
			var text = el.innerText && el.innerText.trim();
			if (text && text.length > 10) blocks.push(text);
		}
	});

	return {
		title: title,
		ogImageUrl: ogImageUrl,
		description: description,
		siteName: siteName,
		author: author,
		publishedDate: publishedDate,
		content: blocks.join('\\n\\n')
	};
})()
`;

interface ExtractResult {
	title: string;
	ogImageUrl: string | null;
	description: string | null;
	siteName: string;
	author: string | null;
	publishedDate: string | null;
	content: string;
}

export async function scrapeWithPlaywright(url: string, browserBinding: Fetcher): Promise<ScrapedContent> {
	logInfo('WEB', 'Playwright scraping', { url });

	const { browser, reused } = await getOrCreateBrowser(browserBinding);
	logInfo('WEB', 'Browser session', { reused, sessionId: browser.sessionId() });

	try {
		const page = await browser.newPage();
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

		// Single evaluate: metadata + content in one CDP round-trip (~13 locator calls → 1)
		const result: ExtractResult = await page.evaluate(EXTRACT_ALL_SCRIPT);

		// close() on a connect()-obtained browser disconnects without killing the session
		await browser.close();
		logInfo('WEB', 'Playwright scraped', { url, chars: result.content.length });

		return {
			title: (result.title || '').trim(),
			content: result.content.trim() || `# ${result.title}`,
			summary: result.description || undefined,
			ogImageUrl: result.ogImageUrl,
			siteName: result.siteName,
			author: result.author,
			publishedDate: result.publishedDate,
		};
	} catch (error) {
		await browser.close().catch(() => {});
		throw error;
	}
}
