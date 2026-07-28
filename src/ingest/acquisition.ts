import { isContentResourceType } from '@core-shared/resource-types';
import type { NormalizedContent, PdfExtractionMetadata, PlatformMetadata, ResourceForProcessing } from '@core-shared/types';
import { detectResourceUrl, normalizeUrl } from '@core-shared/url';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';
import { type HackerNewsItem, scrapeHackerNews } from './platforms/hackernews';
import { acquireRssFeedItem, type RssFeedAcquisitionInput } from './platforms/rss-feed';
import { scrapeTweet } from './platforms/twitter-acquisition';
import { scrapeYouTube } from './platforms/youtube-acquisition';
import { acquireWebResource, PDF_MIME, pdfExtractionMetadata } from './web-acquisition';

export type { PdfExtractionMetadata } from '@core-shared/types';
export { PDF_MIME, pdfExtractionMetadata };

export type AcquiredContent = NormalizedContent & {
	extraction?: PdfExtractionMetadata;
	hackerNewsItem?: HackerNewsItem;
};

function acquiredPublishedDate(value: string | null): string | null {
	if (!value?.trim()) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function applyAcquiredContent(resource: ResourceForProcessing, acquired?: AcquiredContent): ResourceForProcessing {
	if (!acquired) return resource;
	return {
		...resource,
		title: acquired.title.trim(),
		summary: acquired.metadata.description,
		content: acquired.markdown,
		source: acquired.metadata.siteName,
		type: acquired.type === 'web' && resource.type !== 'web' ? resource.type : acquired.type,
		og_image_url: acquired.previewImageUrl?.trim() || resource.og_image_url?.trim() || null,
		platform_metadata: mergeAcquiredPlatformMetadata(resource.platform_metadata, acquired.platformMetadata, acquired.metadata.siteName),
		file_type: acquired.type === 'pdf' || acquired.extraction ? PDF_MIME : resource.file_type,
		published_date: resource.published_date ?? acquiredPublishedDate(acquired.metadata.publishedDate),
	};
}

function mergeAcquiredPlatformMetadata(
	current: PlatformMetadata | undefined,
	acquired: PlatformMetadata,
	source: string,
): PlatformMetadata {
	const sourceName = source.trim();
	if (!sourceName) throw new Error('Acquired content has no source name');
	return {
		...acquired,
		...(current?.enrichments === undefined ? {} : { enrichments: current.enrichments }),
		...(current?.classification === undefined ? {} : { classification: current.classification }),
		sourceName,
	};
}

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
		platformData: acquired.platformMetadata.data,
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
			...sanitized.platformMetadata,
			sourceSnapshotHash: await sourceSnapshotHash(sanitized),
		},
	};
}

/**
 * What a monitored feed contributes is a curation decision; what someone types in
 * is not. Only the monitored path applies the feed policies, so a deliberately
 * saved URL is never rejected for being the kind of thing we don't crawl.
 */
export type AcquisitionOrigin = { monitored: boolean };

export async function scrapeSavedUrl(url: string, env: CoreEnv, origin: AcquisitionOrigin): Promise<AcquiredContent> {
	const validatedUrl = validateAcquisitionUrl(url);
	const detected = detectResourceUrl(validatedUrl);
	if (detected) {
		switch (detected.resourcePlatform) {
			case 'youtube':
				return sanitizeAcquiredContent(await scrapeYouTube(detected.platformId, env.YOUTUBE_API_KEY, origin));
			case 'twitter':
				return sanitizeAcquiredContent(await scrapeTweet(detected.platformId, env.KAITO_API_KEY));
			case 'hackernews':
				return sanitizeAcquiredContent(await scrapeHackerNews(detected.platformId, env));
			default:
				detected.resourcePlatform satisfies never;
		}
	}

	return sanitizeAcquiredContent(await acquireWebResource(validatedUrl, env));
}

export async function scrapeSavedUrlArtifact(url: string, env: CoreEnv, origin: AcquisitionOrigin): Promise<ReadableStream<Uint8Array>> {
	const acquired = await scrapeSavedUrl(url, env, origin);
	return acquiredContentArtifact(acquired);
}

export async function scrapeRssFeedItemArtifact(input: RssFeedAcquisitionInput, env: CoreEnv): Promise<ReadableStream<Uint8Array>> {
	return acquiredContentArtifact(await sanitizeAcquiredContent(await acquireRssFeedItem(env, input)));
}

function acquiredContentArtifact(acquired: AcquiredContent): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(JSON.stringify(acquired));
	return new Blob([bytes], { type: 'application/json' }).stream();
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && !!value.trim();
}

function isAcquiredContent(value: unknown): value is AcquiredContent {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const content = value as Record<string, unknown>;
	if (!isContentResourceType(content.type) || !isNonEmptyString(content.title) || typeof content.markdown !== 'string') return false;
	if (!content.metadata || typeof content.metadata !== 'object' || Array.isArray(content.metadata)) return false;
	if (!content.platformMetadata || typeof content.platformMetadata !== 'object' || Array.isArray(content.platformMetadata)) return false;
	const metadata = content.metadata as Record<string, unknown>;
	const platformMetadata = content.platformMetadata as Record<string, unknown>;
	return (
		isNullableString(metadata.author) &&
		isNullableString(metadata.language) &&
		isNullableString(metadata.publishedDate) &&
		isNonEmptyString(metadata.siteName) &&
		isNullableString(metadata.description) &&
		isNonEmptyString(platformMetadata.fetchedAt) &&
		Object.hasOwn(platformMetadata, 'data')
	);
}

export async function readAcquiredContentArtifact(artifact: ReadableStream<Uint8Array>): Promise<AcquiredContent> {
	const acquired: unknown = await new Response(artifact).json();
	if (!isAcquiredContent(acquired)) throw new Error('Acquisition artifact did not contain valid content');
	return acquired;
}
