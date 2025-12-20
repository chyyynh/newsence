import * as cheerio from 'cheerio';
import type { ScrapedContent } from '../types';

/**
 * Scrapes content from a web page
 */
export async function scrapeWebPage(url: string): Promise<ScrapedContent> {
	console.log(`[WEB-SCRAPER] Scraping ${url}...`);

	const response = await fetch(url, {
		headers: {
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'Accept-Language': 'en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
		},
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}

	const html = await response.text();
	const $ = cheerio.load(html);

	// Extract metadata
	const title =
		$('meta[property="og:title"]').attr('content') ||
		$('meta[name="twitter:title"]').attr('content') ||
		$('title').text() ||
		'';

	let ogImageUrl =
		$('meta[property="og:image"]').attr('content') ||
		$('meta[property="og:image:url"]').attr('content') ||
		$('meta[name="twitter:image"]').attr('content') ||
		$('meta[name="twitter:image:src"]').attr('content') ||
		null;

	// Make relative URLs absolute
	if (ogImageUrl && !ogImageUrl.startsWith('http')) {
		try {
			const baseUrl = new URL(url);
			ogImageUrl = new URL(ogImageUrl, baseUrl.origin).toString();
		} catch {
			ogImageUrl = null;
		}
	}

	const description =
		$('meta[property="og:description"]').attr('content') ||
		$('meta[name="description"]').attr('content') ||
		null;

	const siteName = $('meta[property="og:site_name"]').attr('content') || new URL(url).hostname;

	const author =
		$('meta[name="author"]').attr('content') ||
		$('meta[property="article:author"]').attr('content') ||
		null;

	const publishedDate =
		$('meta[property="article:published_time"]').attr('content') ||
		$('time').attr('datetime') ||
		null;

	// Convert content to Markdown
	const content = extractContentAsMarkdown($, title, url);

	console.log(`[WEB-SCRAPER] Scraped ${url} (content length: ${content.length})`);

	return {
		title: title.trim(),
		content,
		summary: description || undefined,
		ogImageUrl,
		siteName,
		author,
		publishedDate,
	};
}

/**
 * Extracts main content and converts to Markdown
 */
function extractContentAsMarkdown($: cheerio.CheerioAPI, title: string, baseUrl: string): string {
	let content = `# ${title}\n\n`;

	// Remove unwanted elements
	$('script, style, nav, footer, header, aside, .ad, .advertisement, .social-share').remove();

	// Try to find main content area
	const mainContent =
		$('article').first().length > 0
			? $('article').first()
			: $('main').first().length > 0
				? $('main').first()
				: $('[role="main"]').first().length > 0
					? $('[role="main"]').first()
					: $('body');

	const elements = mainContent.find('p, h1, h2, h3, h4, img');

	for (const el of elements) {
		try {
			const element = $(el);

			if (element.is('p')) {
				const text = element.text().trim();
				if (text.length > 0) {
					content += text + '\n\n';
				}
			} else if (element.is('h1')) {
				content += `## ${element.text().trim()}\n\n`;
			} else if (element.is('h2')) {
				content += `### ${element.text().trim()}\n\n`;
			} else if (element.is('h3') || element.is('h4')) {
				content += `#### ${element.text().trim()}\n\n`;
			} else if (element.is('img')) {
				// Skip social/nav images
				if (
					element.hasClass('social-image') ||
					element.hasClass('navbar-logo') ||
					element.hasClass('avatar')
				) {
					continue;
				}

				let imgSrc = element.attr('src') || element.attr('data-src');
				if (imgSrc && !imgSrc.startsWith('http')) {
					try {
						imgSrc = new URL(imgSrc, baseUrl).href;
					} catch {
						continue;
					}
				}

				if (imgSrc) {
					const alt = element.attr('alt') || 'Image';
					content += `![${alt}](${imgSrc})\n\n`;
				}
			}
		} catch (error) {
			console.warn('[WEB-SCRAPER] Error processing element:', error);
		}
	}

	return content.trim();
}
