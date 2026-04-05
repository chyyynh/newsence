// ─────────────────────────────────────────────────────────────
// Platform Scrapers — barrel re-exports
// ─────────────────────────────────────────────────────────────

export { type ScrapedContent, type PlatformType, detectPlatformType, extractTweetId, extractYouTubeId, extractHackerNewsId } from '../models/scraped-content';

// YouTube
export { scrapeYouTube } from '../platforms/youtube/scraper';

// Twitter
export { scrapeTwitterArticle, scrapeTweet, buildTweetMetadata } from '../platforms/twitter/scraper';

// HackerNews
export { HN_ALGOLIA_API, scrapeHackerNews } from '../platforms/hackernews/scraper';

// Web + Unified
export { scrapeWebPage, scrapeUrl, fetchOgImage, type ScrapeOptions, type OgImageResult } from '../platforms/web/scraper';
