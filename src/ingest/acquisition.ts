import { isContentResourceType } from '@core-shared/resource-types';
import type { NormalizedContent, PdfExtractionMetadata } from '@core-shared/types';
import { extractYouTubeId, normalizeUrl } from '@core-shared/web';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';
import { extractHackerNewsId, type HackerNewsItem, scrapeHackerNews } from './platforms/hackernews';
import { extractTweetId, scrapeTweet } from './platforms/twitter-acquisition';
import {
	acquireWebResource,
	EMPTY_OG_IMAGE_PATCH,
	fetchOgImage,
	type OgImagePatch,
	PDF_MIME,
	pdfExtractionMetadata,
} from './platforms/web';
import { scrapeYouTube } from './platforms/youtube-acquisition';

export { EMPTY_OG_IMAGE_PATCH, fetchOgImage, PDF_MIME, pdfExtractionMetadata };
export type { PdfExtractionMetadata } from '@core-shared/types';
export type { OgImagePatch };

export function acquisitionHttpStatus(error: unknown): number | undefined {
	const message = error instanceof Error ? error.message : String(error);
	const status = Number.parseInt(message.match(/\bHTTP\s+(\d{3})\b/i)?.[1] ?? '', 10);
	return Number.isInteger(status) ? status : undefined;
}

export type AcquiredContent = NormalizedContent & {
	extraction?: PdfExtractionMetadata;
	ogImage?: OgImagePatch;
	hackerNewsItem?: HackerNewsItem;
};

export function validateAcquisitionUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');
	if (parsed.username || parsed.password) throw new Error('URL must not include credentials');
	return normalizeUrl(parsed.toString());
}

async function sourceSnapshotHash(acquired: AcquiredContent): Promise<string> {
	const input = JSON.stringify({
		type: acquired.type,
		title: acquired.title,
		markdown: acquired.markdown,
		metadata: acquired.metadata,
		platformData: acquired.platformMetadata?.data,
	});
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sanitizeAcquiredContent(acquired: AcquiredContent): Promise<AcquiredContent> {
	const markdown = sanitizeExtractedMarkdown(acquired.markdown);
	const sanitized = markdown === acquired.markdown ? acquired : { ...acquired, markdown };
	return {
		...sanitized,
		platformMetadata: {
			...(sanitized.platformMetadata ?? { fetchedAt: new Date().toISOString(), data: null }),
			sourceSnapshotHash: await sourceSnapshotHash(sanitized),
		},
	};
}

export async function scrapeSavedUrl(url: string, env: CoreEnv): Promise<AcquiredContent> {
	const validatedUrl = validateAcquisitionUrl(url);

	const videoId = extractYouTubeId(validatedUrl);
	if (videoId) return sanitizeAcquiredContent(await scrapeYouTube(videoId, env.YOUTUBE_API_KEY));

	const tweetId = extractTweetId(validatedUrl);
	if (tweetId) return sanitizeAcquiredContent(await scrapeTweet(tweetId, env.KAITO_API_KEY));

	const hackerNewsId = extractHackerNewsId(validatedUrl);
	if (hackerNewsId) return sanitizeAcquiredContent(await scrapeHackerNews(hackerNewsId, env));

	return sanitizeAcquiredContent(await acquireWebResource(validatedUrl, env));
}

export async function scrapeSavedUrlArtifact(url: string, env: CoreEnv): Promise<ReadableStream<Uint8Array>> {
	const acquired = await scrapeSavedUrl(url, env);
	const bytes = new TextEncoder().encode(JSON.stringify(acquired));
	return new Blob([bytes], { type: 'application/json' }).stream();
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isAcquiredContent(value: unknown): value is AcquiredContent {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const content = value as Record<string, unknown>;
	if (!isContentResourceType(content.type) || !isNullableString(content.title) || typeof content.markdown !== 'string') return false;
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
