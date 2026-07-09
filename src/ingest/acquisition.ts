import type { NormalizedContent, PdfExtractionMetadata } from '@core-shared/types';
import { extractYouTubeId, normalizeUrl } from '@core-shared/web';
import { isResourceType } from '../resources/types';
import { extractHackerNewsId, scrapeHackerNews } from './platforms/hackernews';
import { extractTweetId, scrapeTweet } from './platforms/twitter-acquisition';
import {
	type BlobAcquisitionInput,
	EMPTY_OG_IMAGE_PATCH,
	fetchOgImage,
	type OgImagePatch,
	PDF_MIME,
	pdfExtractionMetadata,
	scrapeGenericUrl,
	scrapeBlob as scrapeWebBlob,
} from './platforms/web';
import { scrapeYouTube } from './platforms/youtube-acquisition';

export { EMPTY_OG_IMAGE_PATCH, fetchOgImage, PDF_MIME, pdfExtractionMetadata };
export type { BlobAcquisitionInput };
export type { PdfExtractionMetadata } from '@core-shared/types';
export type { OgImagePatch };

export type AcquiredContent = NormalizedContent & {
	extraction?: PdfExtractionMetadata;
	ogImage?: OgImagePatch;
};

export function validateAcquisitionUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');
	return normalizeUrl(parsed.toString());
}

export async function scrapeSavedUrl(url: string, env: CoreEnv): Promise<AcquiredContent> {
	const validatedUrl = validateAcquisitionUrl(url);

	const videoId = extractYouTubeId(validatedUrl);
	if (videoId) return scrapeYouTube(videoId, env.YOUTUBE_API_KEY);

	const tweetId = extractTweetId(validatedUrl);
	if (tweetId) return scrapeTweet(tweetId, env.KAITO_API_KEY);

	const hackerNewsId = extractHackerNewsId(validatedUrl);
	if (hackerNewsId) return scrapeHackerNews(hackerNewsId);

	return scrapeGenericUrl(validatedUrl, env);
}

export function scrapeBlob(input: BlobAcquisitionInput, env: CoreEnv): Promise<AcquiredContent> {
	return scrapeWebBlob(input, env);
}

export async function scrapeSavedUrlArtifact(url: string, env: CoreEnv): Promise<ReadableStream<Uint8Array>> {
	const acquired = await scrapeSavedUrl(url, env);
	const bytes = new TextEncoder().encode(JSON.stringify(acquired));
	return new Blob([bytes], { type: 'application/json' }).stream();
}

export async function scrapeBlobArtifact(input: BlobAcquisitionInput, env: CoreEnv): Promise<ReadableStream<Uint8Array>> {
	const acquired = await scrapeBlob(input, env);
	const bytes = new TextEncoder().encode(JSON.stringify(acquired));
	return new Blob([bytes], { type: 'application/json' }).stream();
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isAcquiredContent(value: unknown): value is AcquiredContent {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const content = value as Record<string, unknown>;
	if (!isResourceType(content.type) || !isNullableString(content.title) || typeof content.markdown !== 'string') return false;
	if (!content.metadata || typeof content.metadata !== 'object' || Array.isArray(content.metadata)) return false;
	const metadata = content.metadata as Record<string, unknown>;
	return (
		isNullableString(metadata.author) &&
		isNullableString(metadata.language) &&
		isNullableString(metadata.publishedDate) &&
		isNullableString(metadata.siteName) &&
		isNullableString(metadata.description)
	);
}

export async function readAcquiredContentArtifact(artifact: ReadableStream<Uint8Array>): Promise<AcquiredContent> {
	const acquired: unknown = await new Response(artifact).json();
	if (!isAcquiredContent(acquired)) throw new Error('Acquisition artifact did not contain valid content');
	return acquired;
}
