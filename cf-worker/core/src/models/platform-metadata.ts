// ─────────────────────────────────────────────────────────────
// Canonical Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

// Source types
export type SourceType = 'twitter' | 'youtube' | 'hackernews' | 'default';

// ─────────────────────────────────────────────────────────────
// Twitter
// ─────────────────────────────────────────────────────────────

export interface TwitterMedia {
	url: string;
	type: 'photo' | 'video' | 'animated_gif';
}

interface TwitterAuthorFields {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	authorVerified?: boolean;
}

/** Standard tweet (no external link) */
export interface TwitterStandardData extends TwitterAuthorFields {
	variant?: undefined;
	tweetId?: string;
	media: TwitterMedia[];
	createdAt?: string;
}

/** Tweet sharing external link */
export interface TwitterSharedData extends TwitterAuthorFields {
	variant: 'shared';
	tweetId?: string;
	media: TwitterMedia[];
	createdAt?: string;
	tweetText?: string;
	externalUrl: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
	originalTweetUrl?: string;
}

/** Twitter Article (long-form) */
export interface TwitterArticleData extends TwitterAuthorFields {
	variant: 'article';
	tweetId?: string;
}

export type TwitterMetadata = TwitterStandardData | TwitterSharedData | TwitterArticleData;

// ─────────────────────────────────────────────────────────────
// YouTube
// ─────────────────────────────────────────────────────────────

export interface YouTubeMetadata {
	videoId: string;
	channelName: string;
	channelId?: string;
	channelAvatar?: string;
	duration?: string;
	thumbnailUrl?: string;
	viewCount?: number;
	likeCount?: number;
	commentCount?: number;
	publishedAt?: string;
	description?: string;
	tags?: string[];
}

// ─────────────────────────────────────────────────────────────
// HackerNews
// ─────────────────────────────────────────────────────────────

export interface HackerNewsMetadata {
	itemId: string;
	author: string;
	points: number;
	commentCount: number;
	itemType?: 'story' | 'ask' | 'show' | 'job';
	storyUrl?: string | null;
}

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

export type PlatformMetadata =
	| { type: 'twitter'; fetchedAt: string; data: TwitterMetadata; enrichments?: PlatformEnrichments | null }
	| { type: 'youtube'; fetchedAt: string; data: YouTubeMetadata; enrichments?: PlatformEnrichments | null }
	| { type: 'hackernews'; fetchedAt: string; data: HackerNewsMetadata; enrichments?: PlatformEnrichments | null }
	| { type: 'default'; fetchedAt: string; data: null; enrichments?: PlatformEnrichments | null };

// ─────────────────────────────────────────────────────────────
// Builder Functions
// ─────────────────────────────────────────────────────────────

function now(): string {
	return new Date().toISOString();
}

export function buildTwitterStandard(
	author: TwitterAuthorFields,
	opts?: { tweetId?: string; media?: TwitterMedia[]; createdAt?: string },
): PlatformMetadata & { type: 'twitter' } {
	return {
		type: 'twitter',
		fetchedAt: now(),
		data: {
			...author,
			media: opts?.media ?? [],
			tweetId: opts?.tweetId,
			createdAt: opts?.createdAt,
		},
	};
}

export function buildTwitterShared(
	author: TwitterAuthorFields,
	opts: {
		tweetId?: string;
		media?: TwitterMedia[];
		createdAt?: string;
		tweetText?: string;
		externalUrl: string;
		externalOgImage?: string | null;
		externalTitle?: string | null;
		originalTweetUrl?: string;
	},
): PlatformMetadata & { type: 'twitter' } {
	return {
		type: 'twitter',
		fetchedAt: now(),
		data: {
			variant: 'shared',
			...author,
			media: opts.media ?? [],
			tweetId: opts.tweetId,
			createdAt: opts.createdAt,
			tweetText: opts.tweetText,
			externalUrl: opts.externalUrl,
			externalOgImage: opts.externalOgImage,
			externalTitle: opts.externalTitle,
			originalTweetUrl: opts.originalTweetUrl,
		},
	};
}

export function buildTwitterArticle(author: TwitterAuthorFields, tweetId?: string): PlatformMetadata & { type: 'twitter' } {
	return {
		type: 'twitter',
		fetchedAt: now(),
		data: {
			variant: 'article',
			...author,
			tweetId,
		},
	};
}

export function buildYouTube(data: YouTubeMetadata): PlatformMetadata & { type: 'youtube' } {
	return {
		type: 'youtube',
		fetchedAt: now(),
		data,
	};
}

export function buildHackerNews(data: HackerNewsMetadata): PlatformMetadata & { type: 'hackernews' } {
	return {
		type: 'hackernews',
		fetchedAt: now(),
		data,
	};
}

export function buildDefault(): PlatformMetadata & { type: 'default' } {
	return {
		type: 'default',
		fetchedAt: now(),
		data: null,
	};
}
