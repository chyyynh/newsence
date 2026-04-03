// ─────────────────────────────────────────────────────────────
// Canonical Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

import type { HackerNewsMetadata } from '../platforms/hackernews/metadata';
import type { TwitterMetadata } from '../platforms/twitter/metadata';
import type { YouTubeMetadata } from '../platforms/youtube/metadata';

// Re-exports
export {
	type TwitterMedia,
	type TwitterAuthorFields,
	type TwitterMetadata,
	type QuotedTweetData,
	buildTwitterStandard,
	buildTwitterShared,
	buildTwitterArticle,
} from '../platforms/twitter/metadata';
export { type YouTubeMetadata, buildYouTube } from '../platforms/youtube/metadata';
export { type HackerNewsMetadata, buildHackerNews } from '../platforms/hackernews/metadata';

// ─────────────────────────────────────────────────────────────
// Source types
// ─────────────────────────────────────────────────────────────

export type SourceType = 'twitter' | 'youtube' | 'hackernews' | 'default';

// ─────────────────────────────────────────────────────────────
// Enrichments
// ─────────────────────────────────────────────────────────────

export interface PlatformEnrichments {
	hnUrl?: string;
	externalUrl?: string | null;
	hnText?: string | null;
	commentCount?: number;
	links?: string[];
	processedAt?: string;
}

// ─────────────────────────────────────────────────────────────
// Top-level envelope (discriminated union)
// ─────────────────────────────────────────────────────────────

/** Optional OG image dimensions stored at the envelope level (cross-platform). */
export interface OgImageDimensions {
	ogImageWidth?: number | null;
	ogImageHeight?: number | null;
}

export type PlatformMetadata =
	| ({ type: 'twitter'; fetchedAt: string; data: TwitterMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'youtube'; fetchedAt: string; data: YouTubeMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'hackernews'; fetchedAt: string; data: HackerNewsMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'default'; fetchedAt: string; data: null; enrichments?: PlatformEnrichments | null } & OgImageDimensions);

// ─────────────────────────────────────────────────────────────
// Default Builder
// ─────────────────────────────────────────────────────────────

function now(): string {
	return new Date().toISOString();
}

export function buildDefault(): PlatformMetadata & { type: 'default' } {
	return {
		type: 'default',
		fetchedAt: now(),
		data: null,
	};
}
