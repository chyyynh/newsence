import type { PlatformMetadata } from '@core-shared/platform-metadata';
import { normalizeUrl } from '@core-shared/web';
import { getExistingArticleByUrl, reopenArticleForReprocessing } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import type { Client } from 'pg';
import { buildThreadArticleParts, buildTweetTitle, resolveTweetContent, type Tweet } from './scraper';

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
		platformMetadata: PlatformMetadata;
		hashTags?: string[];
	},
): Promise<boolean> {
	await enqueueProcessing(env, {
		kind: 'source',
		draft: {
			article: {
				url: data.url,
				title: data.title,
				source: data.source,
				publishedDate: data.publishedDate,
				summary: data.summary,
				sourceType: 'twitter',
				content: data.content,
				ogImageUrl: data.ogImage,
				platformMetadata: data.platformMetadata,
				keywords: data.hashTags,
			},
		},
	});
	return true;
}

const MIN_TWEET_LENGTH = 150;

export async function saveTweet(db: Client, tweet: Tweet, env: Env): Promise<boolean> {
	const resolved = await resolveTweetContent(tweet, env.KAITO_API_KEY).catch((err) => {
		console.warn({ tag: 'TWITTER', msg: 'Tweet content resolution failed', url: tweet.url, error: String(err) });
		return null;
	});
	if (!resolved) return false;

	if (resolved.kind === 'tweet' && !tweet.retweetedBy && resolved.eventText.length < MIN_TWEET_LENGTH) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	const articleUrl = normalizeUrl(resolved.canonicalUrl);
	const existingArticle = await getExistingArticleByUrl(db, articleUrl);
	if (existingArticle) {
		if (!existingArticle.summary_cn) await enqueueProcessing(env, { kind: 'article', articleId: existingArticle.id });
		console.info({ tag: 'TWITTER', msg: 'Article already exists (dedup)', url: articleUrl, eventType: resolved.kind });
		return true;
	}

	const { scraped } = resolved;
	const source =
		resolved.kind === 'share'
			? scraped.metadata.siteName || scraped.metadata.author || 'External'
			: tweet.author?.name || scraped.metadata.author || 'Twitter';
	const queued = await enqueueTwitterArticle(env, {
		url: articleUrl,
		title: scraped.title,
		source,
		publishedDate: new Date(scraped.metadata.publishedDate || tweet.createdAt),
		summary: resolved.kind === 'tweet' ? resolved.eventText : scraped.metadata.description || '',
		content: resolved.kind === 'tweet' ? resolved.eventText || null : scraped.markdown,
		ogImage: scraped.metadata.ogImageUrl,
		platformMetadata: scraped.platformMetadata,
		hashTags: tweet.hashTags,
	});
	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved tweet content', kind: resolved.kind, title: scraped.title.slice(0, 50) });
	return queued;
}

export async function saveThread(db: Client, tweets: Tweet[], env: Env): Promise<boolean> {
	const { first, combinedText, media, platformMetadata } = buildThreadArticleParts(tweets);
	const firstUrl = normalizeUrl(first.url);
	const tweetCount = tweets.length;

	const existing = await getExistingArticleByUrl(db, firstUrl);

	if (existing) {
		const existingId = existing.id;
		await reopenArticleForReprocessing(db, existingId, { summary: combinedText, content: combinedText, platformMetadata });
		await enqueueProcessing(env, { kind: 'article', articleId: existingId });
		console.info({ tag: 'TWITTER', msg: 'Updated thread', author: first.author?.userName, tweets: tweetCount });
		return true;
	}

	const queued = await enqueueTwitterArticle(env, {
		url: firstUrl,
		title: buildTweetTitle(first),
		source: first.author?.name || 'Twitter',
		publishedDate: new Date(first.createdAt),
		summary: combinedText,
		content: combinedText,
		ogImage: media[0]?.url ?? null,
		platformMetadata,
		hashTags: first.hashTags,
	});

	if (queued) {
		console.info({ tag: 'TWITTER', msg: 'Saved thread', author: first.author?.userName, tweets: tweetCount });
	}
	return queued;
}
