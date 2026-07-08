import type { PlatformMetadata } from '@core-shared/platform-metadata';
import type { Tweet, WorkflowAttachment } from '@core-shared/types';
import { normalizeUrl } from '@core-shared/web';
import { getExistingArticleByUrl, reopenArticleForReprocessing } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import type { Client } from 'pg';
import { upsertTwitterSourceEventDraft } from './processor';
import { buildThreadArticleParts, buildTweetTitle, resolveTweetContent } from './scraper';

type TwitterSourceEventDraft = Extract<WorkflowAttachment, { kind: 'twitter-source-event' }>['event'];

async function recordExistingTwitterSourceEvent(
	db: Client,
	env: Env,
	article: { id: string; summary_cn: string | null },
	event: TwitterSourceEventDraft,
	options: { enqueueIfIncomplete?: boolean } = {},
): Promise<void> {
	await upsertTwitterSourceEventDraft(db, article.id, event);
	if (options.enqueueIfIncomplete !== false && !article.summary_cn)
		await enqueueProcessing(env, { kind: 'article', articleId: article.id });
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
		platformMetadata: PlatformMetadata;
		hashTags?: string[];
		sourceEvent: TwitterSourceEventDraft;
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
			attachments: [{ kind: 'twitter-source-event' as const, event: data.sourceEvent }],
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
		await recordExistingTwitterSourceEvent(db, env, existingArticle, { tweet, eventType: resolved.kind, text: resolved.eventText });
		console.info({ tag: 'TWITTER', msg: 'Article already exists (dedup)', url: articleUrl, eventType: resolved.kind });
		return true;
	}

	const { scraped } = resolved;
	const source =
		resolved.kind === 'share'
			? scraped.metadata.siteName || scraped.metadata.author || 'External'
			: tweet.author?.name || scraped.metadata.author || 'Twitter';
	const sourceEvent: TwitterSourceEventDraft = { tweet, eventType: resolved.kind, text: resolved.eventText };
	await upsertTwitterSourceEventDraft(db, null, sourceEvent);
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
		sourceEvent,
	});
	if (queued) console.info({ tag: 'TWITTER', msg: 'Saved tweet content', kind: resolved.kind, title: scraped.title.slice(0, 50) });
	return queued;
}

export async function saveThread(db: Client, tweets: Tweet[], env: Env): Promise<boolean> {
	const { first, sorted, combinedText, media, platformMetadata } = buildThreadArticleParts(tweets);
	const firstUrl = normalizeUrl(first.url);

	const existing = await getExistingArticleByUrl(db, firstUrl);

	if (existing) {
		const existingId = existing.id;
		const sourceEvent: TwitterSourceEventDraft = { tweet: first, eventType: 'thread', text: combinedText, media, raw: { tweets: sorted } };
		await recordExistingTwitterSourceEvent(db, env, existing, sourceEvent, { enqueueIfIncomplete: false });
		await reopenArticleForReprocessing(db, existingId, { summary: combinedText, content: combinedText, platformMetadata });
		await enqueueProcessing(env, { kind: 'article', articleId: existingId });
		console.info({ tag: 'TWITTER', msg: 'Updated thread', author: first.author?.userName, tweets: sorted.length });
		return true;
	}

	const sourceEvent: TwitterSourceEventDraft = { tweet: first, eventType: 'thread', text: combinedText, media, raw: { tweets: sorted } };
	await upsertTwitterSourceEventDraft(db, null, sourceEvent);
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
		sourceEvent,
	});

	if (queued) {
		console.info({ tag: 'TWITTER', msg: 'Saved thread', author: first.author?.userName, tweets: sorted.length });
	}
	return queued;
}
