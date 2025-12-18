import { createClient } from '@supabase/supabase-js';
import { Env, ExecutionContext } from '../types';
import { sendMessageToTelegram } from '../utils/telegram';

interface Tweet {
	id?: string;
	url: string;
	createdAt: string;
	viewCount: number;
	author: {
		id?: string;
		userName: string;
		name: string;
		verified?: boolean;
	};
	text: string;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
	media?: any[];
	hashTags?: string[];
	mentions?: any[];
	urls?: any[];
	lang?: string;
	possiblySensitive?: boolean;
	source?: string;
	listType?: string;
}

interface ApiResponse {
	status: string;
	message?: string;
	tweets?: Tweet[];
	has_next_page?: boolean;
	next_cursor?: string;
}

function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles_test_core';
}

async function getLastQueryTime(supabase: any, env: Env): Promise<Date | null> {
	const { data, error } = await supabase
		.from(getArticlesTable(env))
		.select('scraped_date')
		.eq('source_type', 'twitter')
		.order('scraped_date', { ascending: false })
		.limit(1)
		.single();

	if (error && error.code !== 'PGRST116') {
		console.error('[TWITTER] last query time error:', error);
		return null;
	}

	return data ? new Date(data.scraped_date) : null;
}

async function saveTweetToArticles(tweet: Tweet, listId: string, listType: string, supabase: any, env: Env) {
	const table = getArticlesTable(env);

	// Extract first media image as og_image_url
	const og_image_url = tweet.media && tweet.media.length > 0 ? tweet.media[0].url : null;

	const articleData = {
		url: tweet.url,
		title: `@${tweet.author?.userName}: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? '...' : ''}`,
		source: `Twitter - ${listType}`,
		published_date: new Date(tweet.createdAt),
		scraped_date: new Date(),
		keywords: tweet.hashTags || [],
		tags: [],
		tokens: [],
		summary: tweet.text,
		source_type: 'twitter',
		content: JSON.stringify({
			text: tweet.text,
			author: tweet.author,
			metrics: {
				viewCount: tweet.viewCount || 0,
				likeCount: tweet.likeCount || 0,
				retweetCount: tweet.retweetCount || 0,
				replyCount: tweet.replyCount || 0,
				quoteCount: tweet.quoteCount || 0,
			},
			metadata: {
				listType: listType,
				listId: listId,
				hashtags: tweet.hashTags || [],
				mentions: tweet.mentions?.map((m) => m.username) || [],
				urls: tweet.urls?.map((u) => u.expanded_url || u.url) || [],
				lang: tweet.lang,
				possiblySensitive: tweet.possiblySensitive || false,
				originalSource: tweet.source,
				mediaUrls: tweet.media?.map((m) => m.url) || [],
			},
		}),
		og_image_url: og_image_url,
	};

	const { data: existing } = await supabase.from(table).select('id').eq('url', articleData.url).single();
	if (existing) {
		console.log('[TWITTER] already exists, skip:', tweet.id);
		return;
	}

	const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');
	if (error) {
		console.error('[TWITTER] insert error:', error);
		return;
	}

	const articleId = inserted?.[0]?.id;
	if (articleId) {
		await env.TWITTER_QUEUE.send({
			type: 'tweet_scraped',
			article_id: articleId,
			url: articleData.url,
			source: articleData.source,
			source_type: 'twitter',
			timestamp: new Date().toISOString(),
			metadata: { list_type: listType, list_id: listId, view_count: tweet.viewCount },
		});
		console.log(`[TWITTER] queued tweet article ${articleId}`);
	}
}

async function getHighViewTweetsFromList(apiKey: string, listId: string, listType: string, supabase: any, env: Env): Promise<Tweet[]> {
	const allFiltered: Tweet[] = [];
	let cursor: string | null = null;
	let hasNext = true;
	const apiEndpoint = 'https://api.twitterapi.io/twitter/list/tweets';
	const viewThreshold = 10000;

	const headers = { 'X-API-Key': apiKey, 'Content-Type': 'application/json' };
	const lastQueryTime = await getLastQueryTime(supabase, env);
	const sinceTime = lastQueryTime ? new Date(lastQueryTime.getTime() - 60 * 60 * 1000) : new Date(Date.now() - 24 * 60 * 60 * 1000);
	const sinceTimeUnix = Math.floor(sinceTime.getTime() / 1000);

	while (hasNext) {
		const params = new URLSearchParams({
			listId,
			sinceTime: sinceTimeUnix.toString(),
			includeReplies: 'false',
			limit: '20',
		});
		if (cursor) params.append('cursor', cursor);

		const res = await fetch(`${apiEndpoint}?${params}`, { method: 'GET', headers });
		if (!res.ok) {
			console.error(`[TWITTER] HTTP ${res.status} ${res.statusText}`);
			break;
		}
		const data: ApiResponse = await res.json();
		if (data.status !== 'success') {
			console.error('[TWITTER] API error:', data.message);
			break;
		}

		for (const tweet of data.tweets || []) {
			if (tweet.viewCount > viewThreshold) {
				await saveTweetToArticles(tweet, listId, listType, supabase, env);
				allFiltered.push(tweet);
			}
		}

		hasNext = data.has_next_page || false;
		cursor = data.next_cursor || null;
		if (hasNext) await new Promise((r) => setTimeout(r, 1000));
	}

	return allFiltered;
}

export async function handleTwitterCron(env: Env, _ctx: ExecutionContext) {
	console.log('[TWITTER] cron trigger start');
	const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
	const coreListId = '1894659296388157547';
	const applicationListId = '1920007527703662678';

	const [coreTweets, applicationTweets] = await Promise.all([
		getHighViewTweetsFromList(env.KAITO_API_KEY || '', coreListId, 'Core', supabase, env),
		getHighViewTweetsFromList(env.KAITO_API_KEY || '', applicationListId, 'Application', supabase, env),
	]);

	const total = coreTweets.length + applicationTweets.length;
	console.log(`[TWITTER] total high-view tweets inserted: ${total}`);

	if (total > 0 && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
		let message = `發現 ${total} 則高瀏覽量推文\n\n`;
		const formatTweets = (tweets: Tweet[], label: string) => {
			if (!tweets.length) return '';
			let msg = `${label}\n`;
			tweets.forEach((t, idx) => {
				msg += `${idx + 1}. @${t.author?.userName || 'N/A'} - ${t.viewCount.toLocaleString()} 瀏覽\n   ${t.url || 'N/A'}\n`;
			});
			return msg + '\n';
		};
		message += formatTweets(coreTweets, 'Core');
		message += formatTweets(applicationTweets, 'Application');
		await sendMessageToTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, message.trim());
	}

	console.log('[TWITTER] cron trigger end');
}
