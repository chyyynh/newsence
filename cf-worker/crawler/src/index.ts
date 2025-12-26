import type { Env, ScrapeRequest, ScrapeResponse, ScrapeErrorResponse } from './types';
import { detectUrlType, extractTweetId, extractYouTubeId, extractHackerNewsId, normalizeUrl, isValidUrl } from './utils/url';
import { getSupabaseClient, findExistingArticle, insertArticle } from './utils/supabase';
import { scrapeWebPage } from './scrapers/web';
import { scrapeTweet } from './scrapers/twitter';
import { scrapeYouTube } from './scrapers/youtube';
import { scrapeHackerNews } from './scrapers/hackernews';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: ScrapeResponse | ScrapeErrorResponse, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...CORS_HEADERS,
		},
	});
}

function errorResponse(
	code: ScrapeErrorResponse['error']['code'],
	message: string,
	status = 400
): Response {
	return jsonResponse({ success: false, error: { code, message } }, status);
}

async function handleScrape(request: Request, env: Env): Promise<Response> {
	let body: ScrapeRequest;

	try {
		body = await request.json();
	} catch {
		return errorResponse('INVALID_URL', 'Invalid JSON body');
	}

	const { url, userId, collectionId, skipSave } = body;

	// Validate URL
	if (!url || !isValidUrl(url)) {
		return errorResponse('INVALID_URL', 'Invalid or missing URL');
	}

	if (!userId) {
		return errorResponse('UNAUTHORIZED', 'User ID is required');
	}

	const normalizedUrl = normalizeUrl(url);
	const urlType = detectUrlType(url);

	console.log(`[CRAWLER] Processing ${urlType} URL: ${normalizedUrl}`);

	// Check if already exists
	const supabase = getSupabaseClient(env);
	const existing = await findExistingArticle(supabase, normalizedUrl);

	if (existing) {
		console.log(`[CRAWLER] URL already exists: ${existing.id}`);
		return jsonResponse({
			success: true,
			data: {
				articleId: existing.id,
				url,
				normalizedUrl,
				title: existing.title || '',
				content: '',
				summary: existing.summary || undefined,
				source: existing.source || '',
				sourceType: (existing.source_type as 'web' | 'twitter') || urlType,
				ogImageUrl: existing.og_image_url || undefined,
				author: existing.author || undefined,
			},
			alreadyExists: true,
			existingArticleId: existing.id,
		});
	}

	// Scrape content
	let scrapedContent;

	try {
		if (urlType === 'twitter') {
			const tweetId = extractTweetId(url);
			if (!tweetId) {
				return errorResponse('INVALID_URL', 'Could not extract tweet ID from URL');
			}
			scrapedContent = await scrapeTweet(tweetId, env.KAITO_API_KEY);
		} else if (urlType === 'youtube') {
			const videoId = extractYouTubeId(url);
			if (!videoId) {
				return errorResponse('INVALID_URL', 'Could not extract YouTube video ID from URL');
			}
			scrapedContent = await scrapeYouTube(videoId, env.YOUTUBE_API_KEY);
		} else if (urlType === 'hackernews') {
			const itemId = extractHackerNewsId(url);
			if (!itemId) {
				return errorResponse('INVALID_URL', 'Could not extract HackerNews item ID from URL');
			}
			scrapedContent = await scrapeHackerNews(itemId);
		} else {
			scrapedContent = await scrapeWebPage(url);
		}
	} catch (error) {
		console.error('[CRAWLER] Scrape error:', error);
		return errorResponse(
			'FETCH_FAILED',
			error instanceof Error ? error.message : 'Failed to fetch URL',
			500
		);
	}

	// Save to database if not skipSave
	let articleId: string | undefined;

	if (!skipSave) {
		const article = await insertArticle(supabase, {
			url: normalizedUrl,
			title: scrapedContent.title,
			source: scrapedContent.siteName || 'User Added',
			published_date: scrapedContent.publishedDate || new Date().toISOString(),
			scraped_date: new Date().toISOString(),
			summary: scrapedContent.summary,
			source_type: urlType,
			content: scrapedContent.content,
			og_image_url: scrapedContent.ogImageUrl || undefined,
			keywords: [],
			tags: [],
			tokens: [],
		});

		if (article) {
			articleId = article.id;
			console.log(`[CRAWLER] Saved article: ${articleId}`);
		}
	}

	return jsonResponse({
		success: true,
		data: {
			articleId,
			url,
			normalizedUrl,
			title: scrapedContent.title,
			content: scrapedContent.content,
			summary: scrapedContent.summary,
			source: scrapedContent.siteName || 'Unknown',
			sourceType: urlType,
			ogImageUrl: scrapedContent.ogImageUrl || undefined,
			publishedDate: scrapedContent.publishedDate || undefined,
			author: scrapedContent.author || undefined,
			metadata: scrapedContent.metadata,
		},
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS });
		}

		// Health check
		if (url.pathname === '/health' || url.pathname === '/') {
			return new Response(JSON.stringify({ status: 'ok', service: 'opennews-crawler' }), {
				headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
			});
		}

		// Scrape endpoint
		if (url.pathname === '/api/scrape' && request.method === 'POST') {
			// Verify API key
			const authHeader = request.headers.get('Authorization');
			if (!authHeader || authHeader !== `Bearer ${env.API_SECRET_KEY}`) {
				return errorResponse('UNAUTHORIZED', 'Invalid API key', 401);
			}

			return handleScrape(request, env);
		}

		return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
	},
} satisfies ExportedHandler<Env>;
