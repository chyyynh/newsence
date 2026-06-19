import { ARTICLES_TABLE, enqueueArticleProcess, enqueueSourceArticleProcess, type SourceArticleDraft } from '@shared/db';
import type { PlatformMetadata } from '@shared/platform-metadata';
import type { Env, Tweet } from '@shared/types';
import { isSocialMediaUrl, normalizeUrl, resolveUrl, type ScrapedContent } from '@shared/web';
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
	const result = await db.query<{ id: string; summary_cn: string | null }>(
		`SELECT id, summary_cn FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`,
		[url],
	);
	return result.rows[0] ?? null;
}

async function enqueueMissingTwitterTranslation(env: Env, article: { id: string; summary_cn: string | null }): Promise<void> {
	if (article.summary_cn) return;
	await enqueueArticleProcess(env, article.id);
}

async function enqueueTwitterArticle(
	db: Client,
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
		sourceEvent?: SourceArticleDraft['twitterSourceEvent'];
	},
): Promise<boolean> {
	if (await findArticleByUrl(db, data.url)) return false;
	await enqueueSourceArticleProcess(env, {
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
		...(data.sourceEvent ? { twitterSourceEvent: data.sourceEvent } : {}),
	});
	return true;
}

async function handleTwitterArticle(tweet: Tweet, db: Client, env: Env, expandedUrls: string[]): Promise<boolean> {
	const articleUrl = findTwitterArticleUrl(expandedUrls);
	if (!articleUrl) return false;

	const tweetId = tweet.id || tweet.url.split('/').pop();
	if (!tweetId) return false;

	console.info({ tag: 'TWITTER', msg: 'Detected Twitter Article', tweetId, articleUrl });
	const scraped = await scrapeTwitterArticle(tweetId, env.KAITO_API_KEY || '');
	if (!scraped) {
		console.warn({ tag: 'TWITTER', msg: 'Article API failed, falling through' });
		return false;
	}

	const meta = scraped.metadata;
	const authorVerified = typeof meta?.authorVerified === 'boolean' ? meta.authorVerified : tweet.author?.isBlueVerified;
	const queued = await enqueueTwitterArticle(db, env, {
		url: normalizeUrl(tweet.url),
		title: scraped.title,
		source: tweet.author?.name || 'Twitter',
		publishedDate: scraped.publishedDate ? new Date(scraped.publishedDate) : new Date(),
		summary: scraped.summary || '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl || null,
		metadata: buildTwitterArticlePlatformMetadata(tweetId, {
			name: typeof meta?.authorName === 'string' ? meta.authorName : tweet.author?.name,
			userName: typeof meta?.authorUserName === 'string' ? meta.authorUserName : tweet.author?.userName,
			profilePicture: typeof meta?.authorProfilePicture === 'string' ? meta.authorProfilePicture : tweet.author?.profilePicture,
			isBlueVerified: authorVerified,
		}),
		sourceEvent: { tweet, eventType: 'article', text: scraped.summary || stripTweetUrls(tweet.text) },
	});

	if (queued) {
		console.info({ tag: 'TWITTER', msg: 'Saved Twitter Article', title: scraped.title.slice(0, 50) });
	}
	return queued;
}

const MIN_TWEET_LENGTH = 150;

function shouldSaveStandaloneTweet(textWithoutUrls: string): boolean {
	return textWithoutUrls.length >= MIN_TWEET_LENGTH;
}

type FollowLinkResult =
	| { status: 'inserted' }
	| { status: 'handled' }
	| { status: 'skipped'; resolvedUrl?: string; scraped?: ScrapedContent | null };

async function handleFollowLink(
	tweet: Tweet,
	textWithoutUrls: string,
	externalUrl: string,
	db: Client,
	env: Env,
): Promise<FollowLinkResult> {
	const resolvedUrl = await resolveUrl(externalUrl).catch((err) => {
		console.warn({ tag: 'TWITTER', msg: 'Failed to resolve shared link', url: externalUrl, error: String(err) });
		return null;
	});
	if (!resolvedUrl) return { status: 'skipped' };

	if (isSocialMediaUrl(resolvedUrl)) {
		console.info({ tag: 'TWITTER', msg: 'Skipped social media link', url: resolvedUrl });
		return { status: 'skipped', resolvedUrl };
	}
	const existingArticle = await findArticleByUrl(db, resolvedUrl);
	if (existingArticle) {
		await upsertTwitterSourceEvent(db, tweet, { articleId: existingArticle.id, eventType: 'share', text: textWithoutUrls });
		await enqueueMissingTwitterTranslation(env, existingArticle);
		console.info({ tag: 'TWITTER', msg: 'Link already exists (dedup)', url: resolvedUrl });
		return { status: 'handled' };
	}

	const scraped = await scrapeWebPage(resolvedUrl).catch((err) => {
		console.warn({ tag: 'TWITTER', msg: 'Failed to scrape followed link', url: resolvedUrl, error: String(err) });
		return null;
	});
	if (!scraped) return { status: 'skipped', resolvedUrl };

	if (!scraped.content || scraped.content.length < 100) {
		console.info({ tag: 'TWITTER', msg: 'Scraped content too short', url: resolvedUrl, chars: scraped.content?.length ?? 0 });
		return { status: 'skipped', resolvedUrl, scraped };
	}

	const queued = await enqueueTwitterArticle(db, env, {
		url: resolvedUrl,
		title: scraped.title || 'Shared Article',
		source: tweet.author?.name || 'Twitter',
		publishedDate: tweet.createdAt ? new Date(tweet.createdAt) : new Date(),
		summary: '',
		content: scraped.content,
		ogImage: scraped.ogImageUrl,
		metadata: buildTweetPlatformMetadata(tweet, {
			tweetText: textWithoutUrls,
			externalUrl: resolvedUrl,
			externalOgImage: scraped.ogImageUrl,
			externalTitle: scraped.title || null,
			originalTweetUrl: tweet.url,
		}),
		sourceEvent: { tweet, eventType: 'share', text: textWithoutUrls },
	});

	if (queued) {
		console.info({ tag: 'TWITTER', msg: 'Saved shared article', title: scraped.title?.slice(0, 50) });
	}
	return queued ? { status: 'inserted' } : { status: 'skipped', resolvedUrl, scraped };
}

async function saveTweet(tweet: Tweet, db: Client, env: Env): Promise<boolean> {
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
		await enqueueMissingTwitterTranslation(env, existingTweetArticle);
		return false;
	}

	if (await handleTwitterArticle(tweet, db, env, expandedUrls)) return true;

	let linkFallback: Extract<FollowLinkResult, { status: 'skipped' }> | null = null;
	if (externalUrl) {
		const linkResult = await handleFollowLink(tweet, textWithoutUrls, externalUrl, db, env);
		if (linkResult.status === 'inserted') return true;
		if (linkResult.status === 'handled') return false;
		linkFallback = linkResult;
	}

	if (!tweet.retweetedBy && !shouldSaveStandaloneTweet(textWithoutUrls)) {
		console.info({ tag: 'TWITTER', msg: 'Filtered tweet', author: tweet.author?.userName, reason: 'too short standalone tweet' });
		return false;
	}

	const metadataExternalUrl = linkFallback?.resolvedUrl ?? externalUrl;
	const externalOgImage = linkFallback?.scraped?.ogImageUrl ?? null;
	const externalTitle = linkFallback?.scraped?.title || null;

	const metadata = buildTweetPlatformMetadata(
		tweet,
		metadataExternalUrl
			? { tweetText: textWithoutUrls, externalUrl: metadataExternalUrl, externalOgImage, externalTitle, originalTweetUrl: tweet.url }
			: {},
	);
	const media = metadata.data.media ?? [];

	const queued = await enqueueTwitterArticle(db, env, {
		url: tweetUrl,
		title: buildTweetTitle(tweet),
		source: tweet.author?.name || 'Twitter',
		publishedDate: new Date(tweet.createdAt),
		summary: textWithoutUrls,
		content: textWithoutUrls || null,
		ogImage: media[0]?.url ?? externalOgImage ?? null,
		metadata,
		hashTags: tweet.hashTags,
		sourceEvent: { tweet, eventType: externalUrl ? 'share' : 'tweet', text: textWithoutUrls },
	});

	if (queued) {
		console.info({ tag: 'TWITTER', msg: 'Saved tweet', author: tweet.author?.userName });
	}
	return queued;
}

async function saveThread(tweets: Tweet[], db: Client, env: Env): Promise<boolean> {
	const sorted = tweets.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	const first = sorted[0];
	const firstUrl = normalizeUrl(first.url);

	const existing = await db.query(`SELECT id, content FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [firstUrl]);
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

	if (existing.rows.length > 0) {
		const existingId = existing.rows[0].id;
		await db.query(
			`UPDATE ${ARTICLES_TABLE} SET summary = $1, content = $2, platform_metadata = $3, summary_cn = NULL, content_cn = NULL, title_cn = NULL, embedding = NULL WHERE id = $4`,
			[combinedText, combinedText, JSON.stringify(metadata), existingId],
		);
		await enqueueArticleProcess(env, existingId);
		await upsertTwitterSourceEvent(db, first, {
			articleId: existingId,
			eventType: 'thread',
			text: combinedText,
			media: allMedia,
			raw: { tweets: sorted },
		});
		console.info({ tag: 'TWITTER', msg: 'Updated thread', author: first.author?.userName, tweets: sorted.length });
		return true;
	}

	const queued = await enqueueTwitterArticle(db, env, {
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
				if (await saveThread(group, db, env)) count++;
			} else {
				if (await saveTweet(group[0], db, env)) count++;
			}
		} catch (err) {
			console.error({ tag: 'TWITTER', msg: 'Save failed', url: group[0]?.url, error: String(err) });
		}
	}
	return count;
}
