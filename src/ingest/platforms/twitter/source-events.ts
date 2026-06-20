import type { DbClient } from '@shared/db';
import type { RetweetedByData, TwitterMedia } from '@shared/platform-metadata';
import type { Tweet } from '@shared/types';
import { extractTweetMedia, stripTweetUrls } from './scraper';

type TwitterSourceEventType = 'tweet' | 'thread' | 'share' | 'quote' | 'retweet' | 'article';

function buildRetweetedBy(tweet: Tweet): RetweetedByData {
	return {
		tweetId: tweet.id,
		tweetUrl: tweet.url,
		retweetedAt: tweet.createdAt,
		authorName: tweet.author?.name || '',
		authorUserName: tweet.author?.userName || '',
		authorProfilePicture: tweet.author?.profilePicture,
		authorVerified: tweet.author?.isBlueVerified,
	};
}

export function normalizeRetweet(tweet: Tweet): Tweet | null {
	if (tweet.retweeted_tweet) {
		return { ...tweet.retweeted_tweet, retweetedBy: buildRetweetedBy(tweet) };
	}
	if (tweet.text.startsWith('RT @')) return null;
	return tweet;
}

function sourceEventTypeFor(tweet: Tweet, eventType: TwitterSourceEventType): TwitterSourceEventType {
	if (tweet.retweetedBy) return 'retweet';
	if (eventType === 'tweet' && tweet.quoted_tweet) return 'quote';
	return eventType;
}

function publicMetricsFor(tweet: Tweet): Record<string, number | undefined> {
	return {
		viewCount: tweet.viewCount,
		likeCount: tweet.likeCount,
		retweetCount: tweet.retweetCount,
		replyCount: tweet.replyCount,
		quoteCount: tweet.quoteCount,
	};
}

export async function upsertTwitterSourceEvent(
	db: DbClient,
	tweet: Tweet,
	options: {
		articleId: string | null;
		eventType: TwitterSourceEventType;
		text?: string | null;
		media?: TwitterMedia[];
		raw?: unknown;
	},
): Promise<void> {
	const eventTweetId = tweet.retweetedBy?.tweetId ?? tweet.id;
	const eventTweetUrl = tweet.retweetedBy?.tweetUrl ?? tweet.url;
	if (!eventTweetId || !eventTweetUrl) return;

	const author = tweet.retweetedBy
		? {
				name: tweet.retweetedBy.authorName,
				userName: tweet.retweetedBy.authorUserName,
				profilePicture: tweet.retweetedBy.authorProfilePicture,
				isBlueVerified: tweet.retweetedBy.authorVerified,
			}
		: tweet.author;
	const createdAt = tweet.retweetedBy?.retweetedAt ?? tweet.createdAt;
	const eventType = sourceEventTypeFor(tweet, options.eventType);
	const text = options.text ?? stripTweetUrls(tweet.text);
	const mediaAssets = options.media ?? extractTweetMedia(tweet);
	const raw = options.raw ?? tweet;

	try {
		const event = await db.query<{ id: string }>(
			`INSERT INTO twitter_source_events (
				tweet_id, tweet_url, event_type, article_id,
				author_user_name, author_name, author_profile_picture, author_verified,
				text, created_at, lang, public_metrics, raw
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
			ON CONFLICT (tweet_id) DO UPDATE SET
				tweet_url = EXCLUDED.tweet_url,
				event_type = EXCLUDED.event_type,
				article_id = COALESCE(EXCLUDED.article_id, twitter_source_events.article_id),
				author_user_name = EXCLUDED.author_user_name,
				author_name = EXCLUDED.author_name,
				author_profile_picture = EXCLUDED.author_profile_picture,
				author_verified = EXCLUDED.author_verified,
				text = EXCLUDED.text,
				created_at = EXCLUDED.created_at,
				lang = EXCLUDED.lang,
				public_metrics = EXCLUDED.public_metrics,
				raw = EXCLUDED.raw
			RETURNING id`,
			[
				eventTweetId,
				eventTweetUrl,
				eventType,
				options.articleId,
				author?.userName || '',
				author?.name || '',
				author?.profilePicture,
				author?.isBlueVerified,
				text,
				createdAt,
				tweet.lang,
				JSON.stringify(publicMetricsFor(tweet)),
				JSON.stringify(raw),
			],
		);
		const sourceEventId = event.rows[0]?.id;
		if (!sourceEventId) return;

		await db.query('DELETE FROM twitter_media_assets WHERE source_event_id = $1', [sourceEventId]);
		for (const media of mediaAssets) {
			await db.query(
				`INSERT INTO twitter_media_assets (
					source_event_id, media_type, url, video_url, width, height
				) VALUES ($1, $2, $3, $4, $5, $6)`,
				[sourceEventId, media.type, media.url, media.videoUrl, media.width, media.height],
			);
		}

		const references: Array<{ id: string; type: 'quoted' | 'retweeted' | 'replied_to'; metadata?: Record<string, unknown> }> = [];
		if (tweet.retweetedBy && tweet.id) references.push({ id: tweet.id, type: 'retweeted' });
		if (tweet.quoted_tweet?.id) {
			references.push({
				id: tweet.quoted_tweet.id,
				type: 'quoted',
				metadata: {
					authorUserName: tweet.quoted_tweet.author?.userName,
					authorName: tweet.quoted_tweet.author?.name,
					text: stripTweetUrls(tweet.quoted_tweet.text),
				},
			});
		}
		if (tweet.inReplyToId) references.push({ id: tweet.inReplyToId, type: 'replied_to' });

		await db.query('DELETE FROM twitter_references WHERE source_event_id = $1', [sourceEventId]);
		for (const reference of references) {
			await db.query(
				`INSERT INTO twitter_references (
					source_event_id, referenced_tweet_id, reference_type, metadata
				) VALUES ($1, $2, $3, $4::jsonb)
				ON CONFLICT (source_event_id, referenced_tweet_id, reference_type)
				DO UPDATE SET metadata = EXCLUDED.metadata`,
				[sourceEventId, reference.id, reference.type, JSON.stringify(reference.metadata ?? null)],
			);
		}
	} catch (err) {
		console.warn({ tag: 'TWITTER', msg: 'Source event write skipped', tweetId: eventTweetId, error: String(err) });
	}
}
