import { detectPlatformType, extractHackerNewsId, extractTweetId, extractYouTubeId, type ScrapedContent } from '../models/scraped-content';
import { scrapeHackerNews } from './hackernews/scraper';
import { scrapeTweet } from './twitter/scraper';
import { scrapeWebPage } from './web/scraper';
import { scrapeYouTube } from './youtube/scraper';

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
