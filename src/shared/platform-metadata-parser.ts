import {
	buildMetadata,
	type PlatformMetadata,
	type QuotedTweetData,
	type TwitterAuthorFields,
	type TwitterMedia,
	type TwitterMetadata,
} from './platform-metadata';

type PlatformInputType = 'youtube' | 'twitter' | 'hackernews' | 'default';
type HackerNewsItemType = 'story' | 'ask' | 'show' | 'job';
type TwitterVariant = 'shared' | 'article';
type TwitterMediaType = TwitterMedia['type'];

const HACKERNEWS_ITEM_TYPES: readonly HackerNewsItemType[] = ['story', 'ask', 'show', 'job'];
const TWITTER_VARIANTS: readonly TwitterVariant[] = ['shared', 'article'];
const TWITTER_MEDIA_TYPES: readonly TwitterMediaType[] = ['photo', 'video', 'animated_gif'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return asString(value);
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string' || value.trim().length === 0) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
	return strings.length > 0 ? strings : undefined;
}

function asPlatformType(value: unknown, fallbackType: string): PlatformInputType {
	const type = asString(value) ?? fallbackType;
	if (type === 'youtube' || type === 'twitter' || type === 'hackernews') return type;
	return 'default';
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	const str = asString(value);
	return allowed.find((candidate) => candidate === str);
}

function parseTwitterMediaItem(value: unknown): TwitterMedia | null {
	const item = asRecord(value);
	if (!item) return null;
	const url = asString(item.url);
	const type = asEnum(item.type, TWITTER_MEDIA_TYPES);
	if (!url || !type) return null;
	return {
		url,
		type,
		videoUrl: asString(item.videoUrl),
		width: asNumber(item.width),
		height: asNumber(item.height),
	};
}

function asTwitterMediaArray(value: unknown): TwitterMedia[] {
	if (!Array.isArray(value)) return [];
	return value.map(parseTwitterMediaItem).filter((item): item is TwitterMedia => item !== null);
}

function asQuotedTweet(value: unknown): QuotedTweetData | undefined {
	const quote = asRecord(value);
	if (!quote) return undefined;
	const authorName = asString(quote.authorName);
	const authorUserName = asString(quote.authorUserName);
	const text = asString(quote.text);
	if (!authorName || !authorUserName || !text) return undefined;
	return {
		authorName,
		authorUserName,
		text,
		authorProfilePicture: asString(quote.authorProfilePicture),
	};
}

function parseTwitterAuthor(metadata: Record<string, unknown>): TwitterAuthorFields {
	return {
		authorName: asString(metadata.authorName) ?? '',
		authorUserName: asString(metadata.authorUserName) ?? '',
		authorProfilePicture: asString(metadata.authorProfilePicture),
	};
}

export function parsePlatformMetadata(metadata: Record<string, unknown> | undefined, fallbackType: string): PlatformMetadata | null {
	if (!metadata) return null;
	const type = asPlatformType(metadata.type, fallbackType);

	switch (type) {
		case 'youtube':
			return buildMetadata('youtube', {
				videoId: asString(metadata.videoId) ?? '',
				channelName: asString(metadata.channelName) ?? '',
				channelId: asString(metadata.channelId),
				channelAvatar: asString(metadata.channelAvatar),
				duration: asString(metadata.duration),
				thumbnailUrl: asString(metadata.thumbnailUrl),
				viewCount: asNumber(metadata.viewCount),
				likeCount: asNumber(metadata.likeCount),
				commentCount: asNumber(metadata.commentCount),
				publishedAt: asString(metadata.publishedAt),
				description: asString(metadata.description),
				tags: asStringArray(metadata.tags),
			});
		case 'hackernews':
			return buildMetadata('hackernews', {
				itemId: asString(metadata.itemId) ?? '',
				author: asString(metadata.author) ?? '',
				points: asNumber(metadata.points) ?? 0,
				commentCount: asNumber(metadata.commentCount) ?? 0,
				itemType: asEnum(metadata.itemType, HACKERNEWS_ITEM_TYPES),
				storyUrl: asNullableString(metadata.storyUrl),
			});
		case 'twitter': {
			const author = parseTwitterAuthor(metadata);
			const variant = asEnum(metadata.variant, TWITTER_VARIANTS);
			if (variant === 'article') return buildMetadata('twitter', { ...author, variant: 'article' });

			const base: TwitterMetadata = { ...author, media: asTwitterMediaArray(metadata.media), createdAt: asString(metadata.createdAt) };
			if (variant === 'shared') {
				return buildMetadata('twitter', {
					...base,
					variant: 'shared',
					tweetText: asString(metadata.tweetText),
					externalUrl: asString(metadata.externalUrl) ?? '',
					externalOgImage: asNullableString(metadata.externalOgImage),
					externalTitle: asNullableString(metadata.externalTitle),
				});
			}
			return buildMetadata('twitter', { ...base, quotedTweet: asQuotedTweet(metadata.quotedTweet) });
		}
		default:
			return buildMetadata('default', null);
	}
}
