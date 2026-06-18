import type { TwitterAuthorFields, TwitterMedia } from '@shared/platform-metadata';

interface TwitterUrlEntity {
	expanded_url?: string;
	url?: string;
}

interface TwitterMediaEntity {
	media_url_https?: string;
	type?: string;
	sizes?: { large?: { w: number; h: number } };
	video_info?: { variants?: Array<{ bitrate?: number; content_type?: string; url: string }> };
}

export interface TwitterLikeTweet {
	id?: string;
	url?: string;
	text: string;
	createdAt?: string;
	author?: {
		name?: string;
		userName?: string;
		profilePicture?: string;
		isBlueVerified?: boolean;
	};
	urls?: TwitterUrlEntity[];
	entities?: { urls?: TwitterUrlEntity[] };
	extendedEntities?: { media?: TwitterMediaEntity[] };
}

export function extractTweetAuthor(tweet: TwitterLikeTweet): TwitterAuthorFields {
	return {
		authorName: tweet.author?.name || '',
		authorUserName: tweet.author?.userName || '',
		authorProfilePicture: tweet.author?.profilePicture,
	};
}

export function extractTweetMedia(tweet: TwitterLikeTweet): TwitterMedia[] {
	return (
		tweet.extendedEntities?.media?.flatMap((m) => {
			if (!m.media_url_https) return [];
			const result: TwitterMedia = { url: m.media_url_https, type: m.type as TwitterMedia['type'] };
			if (m.sizes?.large) {
				result.width = m.sizes.large.w;
				result.height = m.sizes.large.h;
			}
			if (m.video_info?.variants) {
				const mp4 = m.video_info.variants
					.filter((v) => v.content_type === 'video/mp4')
					.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
				if (mp4) result.videoUrl = mp4.url;
			}
			return [result];
		}) ?? []
	);
}

export function extractExpandedUrls(tweet: TwitterLikeTweet): string[] {
	const urls = tweet.urls ?? tweet.entities?.urls ?? [];
	return urls.map((u) => u.expanded_url || u.url || '').filter(Boolean);
}

export function stripTweetUrls(text: string): string {
	return text.replace(/https?:\/\/\S+/g, '').trim();
}

export function findTwitterArticleUrl(urls: string[]): string | undefined {
	return urls.find((u) => /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
}

export function findExternalUrl(urls: string[]): string | undefined {
	return urls.find((u) => !/(?:twitter\.com|x\.com|t\.co)/.test(u));
}

export function buildTweetTitle(tweet: TwitterLikeTweet, maxLength = 100): string {
	const suffix = tweet.text.length > maxLength ? '...' : '';
	return `@${tweet.author?.userName}: ${tweet.text.substring(0, maxLength)}${suffix}`;
}
