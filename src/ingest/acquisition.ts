import type { NormalizedContent } from '@core-shared/types';
import { extractYouTubeId } from '@core-shared/web';
import { extractHackerNewsId, scrapeHackerNews } from './platforms/hackernews';
import { extractTweetId, scrapeTweet } from './platforms/twitter-acquisition';
import {
	EMPTY_OG_IMAGE_PATCH,
	fetchOgImage,
	type OgImagePatch,
	PDF_MIME,
	type PdfExtractionMetadata,
	pdfExtractionMetadata,
	scrapeGenericUrl,
} from './platforms/web';
import { scrapeYouTube } from './platforms/youtube-acquisition';

export { EMPTY_OG_IMAGE_PATCH, fetchOgImage, PDF_MIME, pdfExtractionMetadata };
export type { OgImagePatch, PdfExtractionMetadata };

export type AcquiredContent = NormalizedContent & {
	extraction?: PdfExtractionMetadata;
	ogImage?: OgImagePatch;
};

export function validateAcquisitionUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');
	return parsed.toString();
}

export async function scrapeSavedUrl(url: string, env: CoreEnv): Promise<AcquiredContent | null> {
	const validatedUrl = validateAcquisitionUrl(url);

	const videoId = extractYouTubeId(validatedUrl);
	if (videoId) return scrapeYouTube(videoId, env.YOUTUBE_API_KEY);

	const tweetId = extractTweetId(validatedUrl);
	if (tweetId) return scrapeTweet(tweetId, env.KAITO_API_KEY);

	const hackerNewsId = extractHackerNewsId(validatedUrl);
	if (hackerNewsId) return scrapeHackerNews(hackerNewsId);

	return scrapeGenericUrl(validatedUrl, env);
}

export async function scrapeSavedUrlArtifact(url: string, env: CoreEnv): Promise<ReadableStream<Uint8Array>> {
	const acquired = await scrapeSavedUrl(url, env);
	const bytes = new TextEncoder().encode(JSON.stringify(acquired));
	return new Blob([bytes], { type: 'application/json' }).stream();
}

export async function readAcquiredContentArtifact(artifact: ReadableStream<Uint8Array>): Promise<AcquiredContent | null> {
	return (await new Response(artifact).json()) as AcquiredContent | null;
}
