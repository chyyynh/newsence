// ─────────────────────────────────────────────────────────────
// Twitter Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

function now(): string {
	return new Date().toISOString();
}

export interface TwitterMedia {
	url: string;
	type: 'photo' | 'video' | 'animated_gif';
	videoUrl?: string;
	width?: number;
	height?: number;
}

export interface TwitterAuthorFields {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
}

export interface QuotedTweetData {
	authorName: string;
	authorUserName: string;
	authorProfilePicture?: string;
	text: string;
}

/** Standard tweet (no external link) */
export interface TwitterStandardData extends TwitterAuthorFields {
	variant?: undefined;
	media: TwitterMedia[];
	createdAt?: string;
	quotedTweet?: QuotedTweetData;
}

/** Tweet sharing external link */
export interface TwitterSharedData extends TwitterAuthorFields {
	variant: 'shared';
	media: TwitterMedia[];
	createdAt?: string;
	tweetText?: string;
	externalUrl: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
}

/** Twitter Article (long-form) */
export interface TwitterArticleData extends TwitterAuthorFields {
	variant: 'article';
}

export type TwitterMetadata = TwitterStandardData | TwitterSharedData | TwitterArticleData;

// ─────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────

export function buildTwitterStandard(
	author: TwitterAuthorFields,
	opts?: { media?: TwitterMedia[]; createdAt?: string; quotedTweet?: QuotedTweetData },
): { type: 'twitter'; fetchedAt: string; data: TwitterMetadata } {
	return {
		type: 'twitter',
		fetchedAt: now(),
		data: { ...author, media: opts?.media ?? [], createdAt: opts?.createdAt, quotedTweet: opts?.quotedTweet },
	};
}

export function buildTwitterShared(
	author: TwitterAuthorFields,
	opts: {
		media?: TwitterMedia[];
		createdAt?: string;
		tweetText?: string;
		externalUrl: string;
		externalOgImage?: string | null;
		externalTitle?: string | null;
	},
): { type: 'twitter'; fetchedAt: string; data: TwitterMetadata } {
	return {
		type: 'twitter',
		fetchedAt: now(),
		data: {
			variant: 'shared',
			...author,
			media: opts.media ?? [],
			createdAt: opts.createdAt,
			tweetText: opts.tweetText,
			externalUrl: opts.externalUrl,
			externalOgImage: opts.externalOgImage,
			externalTitle: opts.externalTitle,
		},
	};
}

export function buildTwitterArticle(author: TwitterAuthorFields): { type: 'twitter'; fetchedAt: string; data: TwitterMetadata } {
	return {
		type: 'twitter',
		fetchedAt: now(),
		data: { variant: 'article', ...author },
	};
}
