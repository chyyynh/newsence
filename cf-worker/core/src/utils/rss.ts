import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Extracts Open Graph image URL from a webpage
 */
export async function extractOgImage(url: string): Promise<string | null> {
	try {
		console.log(`[OG-IMAGE] Extracting og:image from ${url}...`);
		const response = await axios.get(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; NewsenceBot/1.0)',
			},
		});

		const html = response.data;
		const $ = cheerio.load(html);

		// Try to get og:image from meta tags
		let imageUrl =
			$('meta[property="og:image"]').attr('content') ||
			$('meta[property="og:image:url"]').attr('content') ||
			$('meta[name="twitter:image"]').attr('content') ||
			$('meta[name="twitter:image:src"]').attr('content');

		// If image URL is relative, make it absolute
		if (imageUrl && !imageUrl.startsWith('http')) {
			try {
				const baseUrl = new URL(url);
				imageUrl = new URL(imageUrl, baseUrl.origin).toString();
			} catch (urlError) {
				console.warn(`[OG-IMAGE] Failed to convert relative URL to absolute: ${imageUrl}`);
				return null;
			}
		}

		if (imageUrl) {
			console.log(`[OG-IMAGE] Found og:image for ${url}: ${imageUrl}`);
		} else {
			console.log(`[OG-IMAGE] No og:image found for ${url}`);
		}

		return imageUrl || null;
	} catch (error: any) {
		console.warn(`[OG-IMAGE] Failed to extract og:image from ${url}:`, error.message || error);
		return null;
	}
}

/**
 * Normalizes URL by removing tracking and cache-busting parameters
 * This prevents duplicate articles with different URL parameters
 */
export function normalizeUrl(url: string): string {
	try {
		const urlObj = new URL(url);

		// Remove common tracking and cache-busting parameters
		const paramsToRemove = [
			'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
			'_', '__', 'nc', 'cachebust', 'noCache', 'cache', 'rand', 'random',
			'_rnd', '_refresh', '_t', '_ts', '_dc', '_q', '_nocache',
			'timestamp', 'ts', 'time', 'cb', 'r', 'sid', 'ttl', 'vfff', 'ttt'
		];

		paramsToRemove.forEach(param => {
			urlObj.searchParams.delete(param);
		});

		// Return the clean URL
		return urlObj.toString();
	} catch (e) {
		// If URL parsing fails, return the original
		return url;
	}
}

export async function scrapeArticleContent(url: string): Promise<string> {
	try {
		// Add a User-Agent header to mimic a browser request
		console.log(`[RSS-SCRAPER] Scraping content from ${url}...`);
		const headers = {
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
		};
		const response = await axios.get(url, { headers });
		const html = response.data;
		const $ = cheerio.load(html);
		let content = ''; // for accumulating content
		const title = $('title').text();
		content += `# ${title}\n\n`; // Add title to content
		const elements = $('p, img, a, h1, h2, h3'); // Select relevant elements including h2, h3
		const errors: string[] = []; // Array to collect errors during element processing

		for (const el of elements) {
			try {
				const element = $(el); // Wrap the element with cheerio object
				if (element.is('p')) {
					content += element.text().trim() + '\n\n'; // Accumulate paragraph text
				} else if (element.is('h1')) {
					content += `## ${element.text().trim()}\n\n`;
				} else if (element.is('h2')) {
					content += `### ${element.text().trim()}\n\n`;
				} else if (element.is('h3')) {
					content += `#### ${element.text().trim()}\n\n`;
				} else if (element.is('img')) {
					// Filter out unwanted images based on class
					if (
						!element.hasClass('social-image') &&
						!element.hasClass('navbar-logo') &&
						!element.hasClass('_1sjywpl0 bc5nci19k bc5nci4t0 bc5nci4ow') // mirror pfp class
					) {
						let imgSrc = element.attr('src');

						// Handle relative image URLs
						if (imgSrc && !imgSrc.startsWith('http')) {
							try {
								imgSrc = new URL(imgSrc, url).href; // Convert relative to absolute URL
							} catch (urlError: any) {
								errors.push(`Invalid image URL found: ${imgSrc} - ${urlError.message}`);
								imgSrc = undefined; // Skip invalid URLs
							}
						}

						if (imgSrc) {
							content += `![Image](${imgSrc})\n\n`; // Add image in Markdown format
						}
					}
				}
				// Note: 'a' tags are selected but not explicitly processed, they are ignored.
			} catch (elementError: any) {
				// Catch errors during processing of a single element
				errors.push(`Error processing element: ${elementError.message}`);
				// Optionally log the specific element causing trouble: console.error("Problem element:", $.html(el));
			}
		}

		// Log any collected errors after the loop
		if (errors.length > 0) {
			console.warn(`[RSS-SCRAPER] Encountered ${errors.length} errors while processing elements for ${url}:`);
			errors.forEach((err) => console.warn(` - ${err}`));
		}

		console.log(`[RSS-SCRAPER] Scraped content from ${url} (length: ${content.length})`);
		return content.trim(); // Trim final whitespace
	} catch (error: any) {
		// Handle common scraping errors more gracefully
		if (error.response?.status === 403) {
			console.warn(`[RSS-SCRAPER] Access denied (403) for ${url} - likely protected by bot detection`);
		} else if (error.response?.status === 429) {
			console.warn(`[RSS-SCRAPER] Rate limited (429) for ${url}`);
		} else if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
			console.warn(`[RSS-SCRAPER] Network error for ${url}: ${error.code}`);
		} else {
			console.warn(`[RSS-SCRAPER] Failed to scrape ${url}: ${error.message || error}`);
		}
		return '';
	}
}
