// ─────────────────────────────────────────────────────────────
// Twitter Platform Metadata Types
// ─────────────────────────────────────────────────────────────

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

/**
 * Flat shape (mirrors the frontend). `variant` discriminates standard (omitted),
 * `'shared'` (external link — adds tweetText/externalUrl/externalOgImage/externalTitle),
 * and `'article'` (long-form — author only). Constructed via `buildMetadata('twitter', …)`.
 */
export interface TwitterMetadata extends TwitterAuthorFields {
	variant?: 'shared' | 'article';
	media?: TwitterMedia[];
	createdAt?: string;
	quotedTweet?: QuotedTweetData;
	tweetText?: string;
	externalUrl?: string;
	externalOgImage?: string | null;
	externalTitle?: string | null;
}
