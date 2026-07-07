import { getExistingArticlesByUrl, updateArticleTextForReprocessing } from '@core-shared/article-store';
import type { PlatformMetadata } from '@core-shared/platform-metadata';
import type { Tweet } from '@core-shared/types';
import { BROWSER_UA, isSocialMediaUrl, normalizeUrl } from '@core-shared/web';
import { startSourceArticleWorkflow, type TwitterSourceEventDraft } from '@ingest/workflows/queue';
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
import { upsertTwitterSourceEvent } from './source-events';

async function findArticleByUrl(db: Client, url: string): Promise<{ id: string; summary_cn: string | null } | null> {
	const [article] = await getExistingArticlesByUrl(db, [url]);
	return article ? { id: article.id, summary_cn: article.summary_cn } : null;
}

async function enqueueTwitterArticle(
	env: Env,
	db: Client,
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
	if (await findArticleByUrl(db, data.url)) return false;
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
	db: Client,
	env: Env,
	tweet: Tweet,
	tweetUrl: string,
	tweetId: string,
	text: string,
): Promise<boolean> {
	const scraped = await scrapeTwitterArticle(tweetId, env.KAITO_API_KEY);
	if (!scraped) {
		console.warn({ tag: 'TWITTER', msg: 'Article API failed, skipping', tweetId });
		return false;
	}

	const meta = scraped.metadata?.data;
	const authorVerified = typeof meta?.authorVerified === 'boolean' ? meta.authorVerified : tweet.author?.isBlueVerified;
	const queued = await enqueueTwitterArticle(env, db, {
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
	const resolvedUrl = await fetch(externalUrl, {
		method: 'HEAD',
		redirect: 'follow',
		headers: { 'User-Agent': BROWSER_UA },
		signal: AbortSignal.timeout(15_000),
	})
		.then((response) => response.url)
		.catch((err) => {
			console.warn({ tag: 'TWITTER', msg: 'Failed to resolve shared link', url: externalUrl, error: String(err) });
			return null;
		});
	if (!resolvedUrl || isSocialMediaUrl(resolvedUrl)) return false;

	const existingArticle = await findArticleByUrl(db, resolvedUrl);
	if (existingArticle) {
		await upsertTwitterSourceEvent(db, tweet, { articleId: existingArticle.id, eventType: 'share', text });
		if (!existingArticle.summary_cn) await env.ARTICLE_QUEUE.send({ articleId: existingArticle.id });
		console.info({ tag: 'TWITTER', msg: 'Link already exists (dedup)', url: resolvedUrl });
		return false;
	}

	const scraped = await scrapeWebPage(resolvedUrl).catch((err) => {
		console.warn({ tag: 'TWITTER', msg: 'Failed to scrape followed link', url: resolvedUrl, error: String(err) });
		return null;
	});
	if (!scraped?.content || scraped.content.length < 100) return false;

	const queued = await enqueueTwitterArticle(env, db, {
		url: resolvedUrl,
		title: scraped.title || 'Shared Article',
		source: tweet.author?.name || 'Twitter',
		publishedDate: new Date(tweet.createdAt),
		summary: '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl,
		metadata: buildTweetPlatformMetadata(tweet, {
			tweetText: text,
			externalUrl: resolvedUrl,
			externalOgImage: scraped.ogImageUrl,
			externalTitle: scraped.title || null,
			originalTweetUrl: tweet.url,
		}),
		sourceEvent: { tweet, eventType: 'share', text },
	});
	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved shared article', title: scraped.title?.slice(0, 50) });
	return queued;
}

async function saveStandaloneTweet(db: Client, env: Env, tweet: Tweet, tweetUrl: string, text: string): Promise<boolean> {
	if (!tweet.retweetedBy && text.length < MIN_TWEET_LENGTH) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	const metadata = buildTweetPlatformMetadata(tweet);
	const media = metadata.data.media ?? [];

	const queued = await enqueueTwitterArticle(env, db, {
		url: tweetUrl,
		title: buildTweetTitle(tweet),
		source: tweet.author?.name || 'Twitter',
		publishedDate: new Date(tweet.createdAt),
		summary: text,
		content: text || null,
		ogImage: media[0]?.url ?? null,
		metadata,
		hashTags: tweet.hashTags,
		sourceEvent: { tweet, eventType: 'tweet', text },
	});

	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved tweet', author: tweet.author?.userName });
	return queued;
}

async function saveTweet(db: Client, tweet: Tweet, env: Env): Promise<boolean> {
	const tweetUrl = normalizeUrl(tweet.url);
	const expandedUrls = extractExpandedUrls(tweet);
	const externalUrl = findExternalUrl(expandedUrls);
	const textWithoutUrls = stripTweetUrls(tweet.text);

	const existingTweetArticle = await findArticleByUrl(db, tweetUrl);
	if (existingTweetArticle) {
		await upsertTwitterSourceEvent(db, tweet, {
			articleId: existingTweetArticle.id,
			eventType: externalUrl ? 'share' : 'tweet',
			text: textWithoutUrls,
		});
		if (!existingTweetArticle.summary_cn) await env.ARTICLE_QUEUE.send({ articleId: existingTweetArticle.id });
		return false;
	}

	const articleUrl = findTwitterArticleUrl(expandedUrls);
	const tweetId = tweet.id || tweet.url.split('/').pop();
	if (articleUrl) return tweetId ? saveTwitterArticleTweet(db, env, tweet, tweetUrl, tweetId, textWithoutUrls) : false;
	if (externalUrl) return saveSharedLinkTweet(db, env, tweet, externalUrl, textWithoutUrls);
	return saveStandaloneTweet(db, env, tweet, tweetUrl, textWithoutUrls);
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
		await env.ARTICLE_QUEUE.send({ articleId: existingId });
		console.info({ tag: 'TWITTER', msg: 'Updated thread', author: first.author?.userName, tweets: sorted.length });
		return true;
	}

	const queued = await enqueueTwitterArticle(env, db, {
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
