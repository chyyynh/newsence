import { assertExternalFetchable } from '../infra/web';
import { detectPlatformType, extractHackerNewsId, extractTweetId, extractYouTubeId, type ScrapedContent } from '../models/scraped-content';
import { fetchBlob } from './blob/fetcher';
import { scrapeHackerNews } from './hackernews/scraper';
import { scrapeTweet } from './twitter/scraper';
import { isHtmlLike, isRasterImage, peekContentType } from './web/peek';
import { scrapeWebPage } from './web/scraper';
import { scrapeYouTube } from './youtube/scraper';

export interface ScrapeOptions {
	youtubeApiKey?: string;
	kaitoApiKey?: string;
}

export type ScrapeResult =
	| { kind: 'page'; scraped: ScrapedContent }
	| {
			kind: 'blob';
			bytes: ArrayBuffer;
			contentType: string;
			sourceUrl: string;
			suggestedFilename: string;
	  };

const PDF_MIME = 'application/pdf';

export async function scrapeUrl(url: string, options: ScrapeOptions): Promise<ScrapeResult> {
	const platformType = detectPlatformType(url);

	switch (platformType) {
		case 'youtube': {
			const videoId = extractYouTubeId(url);
			if (!videoId) throw new Error('Invalid YouTube URL');
			if (!options.youtubeApiKey) throw new Error('YouTube API key required');
			return { kind: 'page', scraped: await scrapeYouTube(videoId, options.youtubeApiKey) };
		}

		case 'twitter': {
			const tweetId = extractTweetId(url);
			if (!tweetId) throw new Error('Invalid Twitter URL');
			if (!options.kaitoApiKey) throw new Error('Kaito API key required');
			return { kind: 'page', scraped: await scrapeTweet(tweetId, options.kaitoApiKey) };
		}

		case 'hackernews': {
			const itemId = extractHackerNewsId(url);
			if (!itemId) throw new Error('Invalid HackerNews URL');
			return { kind: 'page', scraped: await scrapeHackerNews(itemId) };
		}

		default: {
			assertExternalFetchable(url);
			const peek = await peekContentType(url);
			if (isHtmlLike(peek.contentType)) {
				return { kind: 'page', scraped: await scrapeWebPage(url) };
			}
			if (peek.contentType === PDF_MIME || isRasterImage(peek.contentType)) {
				const fallback = peek.contentType === PDF_MIME ? 'document.pdf' : 'image';
				const blob = await fetchBlob(url, peek.contentType, fallback);
				return {
					kind: 'blob',
					bytes: blob.bytes,
					contentType: blob.contentType,
					sourceUrl: blob.finalUrl,
					suggestedFilename: blob.suggestedFilename,
				};
			}
			throw new Error(`Unsupported content-type: ${peek.contentType}`);
		}
	}
}
