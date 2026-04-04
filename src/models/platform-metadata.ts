// ─────────────────────────────────────────────────────────────
// Canonical Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

import type { BilibiliMetadata } from '../platforms/bilibili/metadata';
import type { HackerNewsMetadata } from '../platforms/hackernews/metadata';
import type { TwitterMetadata } from '../platforms/twitter/metadata';
import type { XiaohongshuMetadata } from '../platforms/xiaohongshu/metadata';
import type { YouTubeMetadata } from '../platforms/youtube/metadata';

export { type BilibiliMetadata, buildBilibili } from '../platforms/bilibili/metadata';
export { buildHackerNews, type HackerNewsMetadata } from '../platforms/hackernews/metadata';
// Re-exports
export {
	buildTwitterArticle,
	buildTwitterShared,
	buildTwitterStandard,
	type QuotedTweetData,
	type TwitterAuthorFields,
	type TwitterMedia,
	type TwitterMetadata,
} from '../platforms/twitter/metadata';
export { buildXiaohongshu, type XiaohongshuMetadata } from '../platforms/xiaohongshu/metadata';
export { buildYouTube, type YouTubeMetadata } from '../platforms/youtube/metadata';

// ─────────────────────────────────────────────────────────────
// Source types
// ─────────────────────────────────────────────────────────────

export type SourceType = 'twitter' | 'youtube' | 'hackernews' | 'bilibili' | 'xiaohongshu' | 'default';

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
	| ({ type: 'bilibili'; fetchedAt: string; data: BilibiliMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
	| ({ type: 'xiaohongshu'; fetchedAt: string; data: XiaohongshuMetadata; enrichments?: PlatformEnrichments | null } & OgImageDimensions)
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
