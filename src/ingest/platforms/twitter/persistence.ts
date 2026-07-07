import { getExistingArticlesByUrl, updateArticleTextForReprocessing } from '@core-shared/article-store';
import type { PlatformMetadata, TwitterMedia } from '@core-shared/platform-metadata';
import type { Tweet } from '@core-shared/types';
import { extractTweetId, isSocialMediaUrl, normalizeUrl } from '@core-shared/web';
import { startRowWorkflow, startSourceArticleWorkflow, type TwitterSourceEventDraft } from '@ingest/workflows/queue';
import type { Client } from 'pg';
import { scrapeWebPage } from '../web-scraper';
import {
	buildTweetPlatformMetadata,
	buildTweetTitle,
	buildTwitterArticlePlatformMetadata,
	extractExpandedUrls,
	extractQuotedTweet,
	extractTweetMedia,
	findExternalUrl,
	findTwitterArticleUrl,
	scrapeTwitterArticle,
	stripTweetUrls,
} from './scraper';

async function findArticleByUrl(db: Client, url: string): Promise<{ id: string; summary_cn: string | null } | null> {
	const [article] = await getExistingArticlesByUrl(db, [url]);
	return article ? { id: article.id, summary_cn: article.summary_cn } : null;
}

type TwitterSourceEventInputType = 'tweet' | 'thread' | 'share' | 'article';
type TwitterSourceEventType = TwitterSourceEventInputType | 'quote' | 'retweet';

export async function upsertTwitterSourceEvent(
	db: Client,
	tweet: Tweet,
	options: {
		articleId: string | null;
		eventType: TwitterSourceEventInputType;
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
	let eventType: TwitterSourceEventType = options.eventType;
	if (tweet.retweetedBy) eventType = 'retweet';
	else if (eventType === 'tweet' && tweet.quoted_tweet) eventType = 'quote';
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
				JSON.stringify({
					viewCount: tweet.viewCount,
					likeCount: tweet.likeCount,
					retweetCount: tweet.retweetCount,
					replyCount: tweet.replyCount,
					quoteCount: tweet.quoteCount,
				}),
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

async function enqueueTwitterArticle(
	env: Env,
	data: {
		url: string;
		title: string;
		source: string;
		publishedDate: Date;
		summary: string;
		content: string | null;
		ogImage: string | null;
		metadata: PlatformMetadata;
		hashTags?: string[];
		sourceEvent?: TwitterSourceEventDraft;
	},
): Promise<boolean> {
	await startSourceArticleWorkflow(env, {
		article: {
			url: data.url,
			title: data.title,
			source: data.source,
			publishedDate: data.publishedDate,
			summary: data.summary,
			sourceType: 'twitter',
			content: data.content,
			ogImageUrl: data.ogImage,
			platformMetadata: data.metadata,
			keywords: data.hashTags,
		},
		...(data.sourceEvent ? { attachments: [{ kind: 'twitter-source-event' as const, event: data.sourceEvent }] } : {}),
	});
	return true;
}

const MIN_TWEET_LENGTH = 150;

async function saveTwitterArticleTweet(
	env: Env,
	tweet: Tweet,
	tweetUrl: string,
	tweetId: string,
	text: string,
	logMissingArticle = true,
): Promise<boolean> {
	const scraped = await scrapeTwitterArticle(tweetId, env.KAITO_API_KEY);
	if (!scraped) {
		if (logMissingArticle) console.warn({ tag: 'TWITTER', msg: 'Article API failed, skipping', tweetId });
		return false;
	}

	const meta = scraped.metadata?.data;
	const authorVerified = typeof meta?.authorVerified === 'boolean' ? meta.authorVerified : tweet.author?.isBlueVerified;
	const queued = await enqueueTwitterArticle(env, {
		url: tweetUrl,
		title: scraped.title,
		source: tweet.author?.name || 'Twitter',
		publishedDate: new Date(scraped.publishedDate ?? tweet.createdAt),
		summary: scraped.summary || '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl,
		metadata: buildTwitterArticlePlatformMetadata(tweetId, {
			name: typeof meta?.authorName === 'string' ? meta.authorName : tweet.author?.name,
			userName: typeof meta?.authorUserName === 'string' ? meta.authorUserName : tweet.author?.userName,
			profilePicture: typeof meta?.authorProfilePicture === 'string' ? meta.authorProfilePicture : tweet.author?.profilePicture,
			isBlueVerified: authorVerified,
		}),
		sourceEvent: { tweet, eventType: 'article', text: scraped.summary || text },
	});
	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved Twitter Article', title: scraped.title.slice(0, 50) });
	return queued;
}

async function saveSharedLinkTweet(db: Client, env: Env, tweet: Tweet, externalUrl: string, text: string): Promise<boolean> {
	const articleUrl = normalizeUrl(externalUrl);
	if (isSocialMediaUrl(articleUrl)) return false;

	const existingArticle = await findArticleByUrl(db, articleUrl);
	if (existingArticle) {
		await upsertTwitterSourceEvent(db, tweet, { articleId: existingArticle.id, eventType: 'share', text });
		if (!existingArticle.summary_cn) await startRowWorkflow(env, { articleId: existingArticle.id });
		console.info({ tag: 'TWITTER', msg: 'Link already exists (dedup)', url: articleUrl });
		return true;
	}

	const scraped = await scrapeWebPage(articleUrl).catch((err) => {
		console.warn({ tag: 'TWITTER', msg: 'Failed to scrape shared link', url: articleUrl, error: String(err) });
		return null;
	});
	if (!scraped?.content || scraped.content.length < 100) return false;

	const queued = await enqueueTwitterArticle(env, {
		url: articleUrl,
		title: scraped.title || 'Shared Article',
		source: tweet.author?.name || 'Twitter',
		publishedDate: new Date(tweet.createdAt),
		summary: '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl,
		metadata: buildTweetPlatformMetadata(tweet, {
			tweetText: text,
			externalUrl: articleUrl,
			externalOgImage: scraped.ogImageUrl,
			externalTitle: scraped.title || null,
			originalTweetUrl: tweet.url,
		}),
		sourceEvent: { tweet, eventType: 'share', text },
	});
	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved shared article', title: scraped.title?.slice(0, 50) });
	return queued;
}

async function saveStandaloneTweet(env: Env, tweet: Tweet, tweetUrl: string, text: string, externalUrl?: string): Promise<boolean> {
	if (!tweet.retweetedBy && text.length < MIN_TWEET_LENGTH) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	const metadata = buildTweetPlatformMetadata(tweet, externalUrl ? { externalUrl, tweetText: text, originalTweetUrl: tweet.url } : {});
	const media = metadata.data.media ?? [];

	const queued = await enqueueTwitterArticle(env, {
		url: tweetUrl,
		title: buildTweetTitle(tweet),
		source: tweet.author?.name || 'Twitter',
		publishedDate: new Date(tweet.createdAt),
		summary: text,
		content: text || null,
		ogImage: media[0]?.url ?? null,
		metadata,
		hashTags: tweet.hashTags,
		sourceEvent: { tweet, eventType: externalUrl ? 'share' : 'tweet', text },
	});

	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved tweet', author: tweet.author?.userName });
	return queued;
}

async function saveTweet(db: Client, tweet: Tweet, env: Env): Promise<boolean> {
	const tweetUrl = normalizeUrl(tweet.url);
	const expandedUrls = extractExpandedUrls(tweet);
	const externalUrl = findExternalUrl(expandedUrls);
	const articleUrl = findTwitterArticleUrl(expandedUrls, tweet.url);
	const tweetId = tweet.id ?? extractTweetId(tweet.url);
	const textWithoutUrls = stripTweetUrls(tweet.text);

	const existingTweetArticle = await findArticleByUrl(db, tweetUrl);
	if (existingTweetArticle) {
		await upsertTwitterSourceEvent(db, tweet, {
			articleId: existingTweetArticle.id,
			eventType: articleUrl ? 'article' : externalUrl ? 'share' : 'tweet',
			text: textWithoutUrls,
		});
		if (!existingTweetArticle.summary_cn) await startRowWorkflow(env, { articleId: existingTweetArticle.id });
		return false;
	}

	if (articleUrl) return tweetId ? saveTwitterArticleTweet(env, tweet, tweetUrl, tweetId, textWithoutUrls) : false;
	if (!externalUrl && textWithoutUrls.length < MIN_TWEET_LENGTH && tweetId) {
		if (await saveTwitterArticleTweet(env, tweet, tweetUrl, tweetId, textWithoutUrls, false)) return true;
	}
	if (externalUrl && (await saveSharedLinkTweet(db, env, tweet, externalUrl, textWithoutUrls))) return true;
	return saveStandaloneTweet(env, tweet, tweetUrl, textWithoutUrls, externalUrl);
}

async function saveThread(db: Client, tweets: Tweet[], env: Env): Promise<boolean> {
	const sorted = tweets.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	const first = sorted[0];
	const firstUrl = normalizeUrl(first.url);

	const existing = await findArticleByUrl(db, firstUrl);
	const seen = new Set<string>();
	const uniqueTexts: string[] = [];
	for (const t of sorted.slice(0, 10)) {
		const text = stripTweetUrls(t.text);
		if (text && !seen.has(text)) {
			seen.add(text);
			uniqueTexts.push(text);
		}
	}
	const combinedText = uniqueTexts.join('\n\n');
	const allMedia = sorted.flatMap(extractTweetMedia);
	const quotedTweet = sorted.map(extractQuotedTweet).find(Boolean);
	const metadata = buildTweetPlatformMetadata(first, { media: allMedia, quotedTweet });

	if (existing) {
		const existingId = existing.id;
		await updateArticleTextForReprocessing(db, existingId, { summary: combinedText, content: combinedText, platformMetadata: metadata });
		await upsertTwitterSourceEvent(db, first, {
			articleId: existingId,
			eventType: 'thread',
			text: combinedText,
			media: allMedia,
			raw: { tweets: sorted },
		});
		await startRowWorkflow(env, { articleId: existingId });
		console.info({ tag: 'TWITTER', msg: 'Updated thread', author: first.author?.userName, tweets: sorted.length });
		return true;
	}

	const queued = await enqueueTwitterArticle(env, {
		url: firstUrl,
		title: buildTweetTitle(first),
		source: first.author?.name || 'Twitter',
		publishedDate: new Date(first.createdAt),
		summary: combinedText,
		content: combinedText,
		ogImage: allMedia[0]?.url ?? null,
		metadata,
		hashTags: first.hashTags,
		sourceEvent: { tweet: first, eventType: 'thread', text: combinedText, media: allMedia, raw: { tweets: sorted } },
	});

	if (queued) {
		console.info({ tag: 'TWITTER', msg: 'Saved thread', author: first.author?.userName, tweets: sorted.length });
	}
	return queued;
}

export async function saveTweetGroups(db: Client, env: Env, groups: Tweet[][]): Promise<number> {
	let count = 0;
	for (const group of groups) {
		try {
			if (group.length >= 2) {
				if (await saveThread(db, group, env)) count++;
			} else {
				if (await saveTweet(db, group[0], env)) count++;
			}
		} catch (err) {
			console.error({ tag: 'TWITTER', msg: 'Save failed', url: group[0]?.url, error: String(err) });
		}
	}
	return count;
}
