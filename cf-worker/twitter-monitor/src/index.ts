import { sendMessageToTelegram } from './utils';
import { createClient } from '@supabase/supabase-js';

// Define necessary types locally
interface ScheduledEvent {
	type: 'scheduled';
	scheduledTime: number;
}

interface ExecutionContext {
	waitUntil(promise: Promise<any>): void;
	passThroughOnException(): void;
}

interface Queue {
	send(message: any): Promise<void>;
}

interface Env {
	KAITO_API_KEY: string;
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_CHAT_ID: string;
	twitter_handle: Queue;
}

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

interface TelegramUpdate {
	message?: {
		text?: string;
		from: { id: number };
		chat: { id: number };
	};
}

async function getLastQueryTime(_listId: string, supabase: any): Promise<Date | null> {
	try {
		const { data, error } = await supabase
			.from('articles')
			.select('scraped_date')
			.eq('source_type', 'twitter')
			.like('source', '%Twitter%')
			.order('scraped_date', { ascending: false })
			.limit(1)
			.single();

		if (error && error.code !== 'PGRST116') {
			console.error('Error getting last query time:', error);
			return null;
		}

		return data ? new Date(data.scraped_date) : null;
	} catch (error) {
		console.error('Error in getLastQueryTime:', error);
		return null;
	}
}

async function saveTweetToSupabase(tweet: Tweet, listId: string, listType: string, supabase: any, env?: Env): Promise<void> {
	try {
		// Convert tweet to article format for the articles table
		const articleData = {
			url: tweet.url,
			title: `@${tweet.author?.userName}: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? '...' : ''}`,
			source: `Twitter - ${listType}`,
			published_date: new Date(tweet.createdAt),
			scraped_date: new Date(),
			keywords: tweet.hashTags || [],
			tags: [], // Will be filled by separate cronjob like RSS feeds
			tokens: [], // Will be filled by separate cronjob
			summary: tweet.text,
			source_type: 'twitter',
			content: JSON.stringify({
				text: tweet.text,
				author: {
					id: tweet.author?.id,
					username: tweet.author?.userName,
					name: tweet.author?.name,
					verified: tweet.author?.verified || false
				},
				metrics: {
					viewCount: tweet.viewCount || 0,
					likeCount: tweet.likeCount || 0,
					retweetCount: tweet.retweetCount || 0,
					replyCount: tweet.replyCount || 0,
					quoteCount: tweet.quoteCount || 0
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
					mediaUrls: tweet.media?.map((m) => m.url) || []
				}
			})
		};

		// Check if article already exists by URL
		const { data: existingArticle } = await supabase
			.from('articles')
			.select('id')
			.eq('url', articleData.url)
			.single();

		if (existingArticle) {
			console.log('Tweet already exists in articles table:', tweet.id);
			return;
		}

		const { data: insertedData, error } = await supabase
			.from('articles')
			.insert([articleData])
			.select('id');

		if (error) {
			console.error('Error saving tweet to articles table:', error);
		} else {
			console.log('Tweet saved successfully to articles table:', tweet.id);
			
			// Send message to queue to trigger workflow processing
			if (insertedData && insertedData.length > 0 && env?.twitter_handle) {
				try {
					await env.twitter_handle.send({
						type: 'tweet_scraped',
						article_id: insertedData[0].id,
						url: articleData.url,
						source: articleData.source,
						source_type: 'twitter',
						timestamp: new Date().toISOString(),
						metadata: {
							list_type: listType,
							list_id: listId,
							view_count: tweet.viewCount
						}
					});
					console.log(`📨 Sent queue message for tweet: ${insertedData[0].id}`);
				} catch (queueError) {
					console.error('Failed to send queue message:', queueError);
				}
			}
		}
	} catch (error) {
		console.error('Error in saveTweetToSupabase:', error);
	}
}

async function getHighViewTweetsFromList(apiKey: string, listId: string, listType: string, supabase: any, env?: Env): Promise<Tweet[]> {
	const allFilteredTweets: Tweet[] = [];
	let cursor: string | null = null;
	let hasNextPage = true;

	const apiEndpoint = 'https://api.twitterapi.io/twitter/list/tweets';
	const viewThreshold = 10000;

	const headers = {
		'X-API-Key': apiKey,
		'Content-Type': 'application/json',
	};

	// 獲取上次查詢時間，如果沒有則使用 24 小時前
	const lastQueryTime = await getLastQueryTime(listId, supabase);
	const now = new Date();
	let sinceTime: Date;

	if (lastQueryTime) {
		// 如果有上次查詢時間，從那時開始查詢（減去 1 小時緩衝）
		sinceTime = new Date(lastQueryTime.getTime() - 60 * 60 * 1000); // 減去 1 小時緩衝
		console.log(`Using last query time: ${lastQueryTime.toISOString()}, querying since: ${sinceTime.toISOString()}`);
	} else {
		// 如果沒有上次查詢記錄，查詢過去 24 小時
		sinceTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		console.log(`No previous query found, querying past 24 hours since: ${sinceTime.toISOString()}`);
	}

	const sinceTimeUnix = Math.floor(sinceTime.getTime() / 1000);

	console.log(
		`Starting query for ${listType} list ID '${listId}'. Searching for tweets since ${sinceTime.toISOString()} (Unix: ${sinceTimeUnix}) with view count > ${viewThreshold}...`
	);

	while (hasNextPage) {
		const params = new URLSearchParams({
			listId: listId,
			sinceTime: sinceTimeUnix.toString(),
			includeReplies: 'false',
			limit: '20',
		});

		if (cursor) {
			params.append('cursor', cursor);
		}

		try {
			const response = await fetch(`${apiEndpoint}?${params}`, {
				method: 'GET',
				headers,
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error(`HTTP error: ${response.status}. Response: ${errorText}`);
				break;
			}

			const data: ApiResponse = await response.json();

			if (data.status !== 'success') {
				console.error(`API returned error status: ${data.status}. Message: ${data.message || 'Unknown error'}`);
				break;
			}

			if (data.tweets && data.tweets.length > 0) {
				let currentPageFilteredCount = 0;
				for (const tweet of data.tweets) {
					if (tweet.viewCount > viewThreshold) {
						// 只保存高瀏覽量推文到 Supabase
						await saveTweetToSupabase(tweet, listId, listType, supabase, env);
						tweet.listType = listType;
						allFilteredTweets.push(tweet);
						currentPageFilteredCount++;
					}
				}

				console.log(`Current page retrieved ${data.tweets.length} tweets, ${currentPageFilteredCount} meet view count criteria.`);

				hasNextPage = data.has_next_page || false;
				cursor = data.next_cursor || null;

				if (hasNextPage) {
					console.log('Next page exists, continuing...');
				} else {
					console.log('Reached last page or no more tweets.');
				}
			} else {
				console.log('No tweets retrieved on current page.');
				hasNextPage = false;
			}

			// Rate limiting - wait 1 second between requests
			if (hasNextPage) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		} catch (error) {
			console.error(`Error during API request:`, error);
			break;
		}
	}

	return allFilteredTweets;
}

async function getAllHighViewTweets(apiKey: string, supabase: any, env?: Env): Promise<{ coreTweets: Tweet[]; applicationTweets: Tweet[] }> {
	const coreListId = '1894659296388157547'; // AI Core list
	const applicationListId = '1920007527703662678'; // AI Application list

	const [coreTweets, applicationTweets] = await Promise.all([
		getHighViewTweetsFromList(apiKey, coreListId, 'Core', supabase, env),
		getHighViewTweetsFromList(apiKey, applicationListId, 'Application', supabase, env),
	]);

	return { coreTweets, applicationTweets };
}

async function handleTelegramMessage(update: TelegramUpdate, env: Env): Promise<void> {
	if (!update.message?.text) return;

	const messageText = update.message.text.toLowerCase();
	const chatId = update.message.chat.id.toString();

	// 檢查是否為查詢熱門 AI 訊息的指令
	if (messageText.includes('熱門') || messageText.includes('ai') || messageText.includes('查詢') || messageText === '/hot') {
		await sendMessageToTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '正在查詢熱門 AI 推文，請稍候...');

		try {
			const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
			const { coreTweets, applicationTweets } = await getAllHighViewTweets(env.KAITO_API_KEY, supabase, env);

			if (coreTweets.length > 0 || applicationTweets.length > 0) {
				let message = `發現 ${coreTweets.length + applicationTweets.length} 則高瀏覽量推文\n\n`;

				if (coreTweets.length > 0) {
					message += `Core\n`;
					for (let i = 0; i < coreTweets.length; i++) {
						const tweet = coreTweets[i];
						message += `${i + 1}. @${tweet.author?.userName || 'N/A'} - ${tweet.viewCount.toLocaleString()} 瀏覽\n`;
						message += `   ${tweet.url || 'N/A'}\n`;
					}
					message += `\n`;
				}

				if (applicationTweets.length > 0) {
					message += `Application\n`;
					for (let i = 0; i < applicationTweets.length; i++) {
						const tweet = applicationTweets[i];
						message += `${i + 1}. @${tweet.author?.userName || 'N/A'} - ${tweet.viewCount.toLocaleString()} 瀏覽\n`;
						message += `   ${tweet.url || 'N/A'}\n`;
					}
				}

				await sendMessageToTelegram(env.TELEGRAM_BOT_TOKEN, chatId, message);
			} else {
				await sendMessageToTelegram(env.TELEGRAM_BOT_TOKEN, chatId, '過去24小時內沒有發現瀏覽量超過10,000的推文');
			}
		} catch (error) {
			console.error('Error in telegram message handler:', error);
			await sendMessageToTelegram(
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				`查詢過程中發生錯誤: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	} else {
		// 回應使用說明
		await sendMessageToTelegram(
			env.TELEGRAM_BOT_TOKEN,
			chatId,
			'發送包含 "熱門"、"AI" 或 "查詢" 的訊息，或使用 /hot 指令來查詢熱門 AI 推文'
		);
	}
}

export default {
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		try {
			const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
			const { coreTweets, applicationTweets } = await getAllHighViewTweets(env.KAITO_API_KEY, supabase, env);

			if (coreTweets.length > 0 || applicationTweets.length > 0) {
				console.log(
					`\n--- Successfully found ${
						coreTweets.length + applicationTweets.length
					} tweets in the past 24 hours with view count > 10,000 ---`
				);

				let message = `發現 ${coreTweets.length + applicationTweets.length} 則高瀏覽量推文\n\n`;

				if (coreTweets.length > 0) {
					message += `Core\n`;
					for (let i = 0; i < coreTweets.length; i++) {
						const tweet = coreTweets[i];
						message += `${i + 1}. @${tweet.author?.userName || 'N/A'} - ${tweet.viewCount.toLocaleString()} 瀏覽\n`;
						message += `   ${tweet.url || 'N/A'}\n`;
					}
					message += `\n`;
				}

				if (applicationTweets.length > 0) {
					message += `Application\n`;
					for (let i = 0; i < applicationTweets.length; i++) {
						const tweet = applicationTweets[i];
						message += `${i + 1}. @${tweet.author?.userName || 'N/A'} - ${tweet.viewCount.toLocaleString()} 瀏覽\n`;
						message += `   ${tweet.url || 'N/A'}\n`;
					}
				}

				await sendMessageToTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, message);
			} else {
				console.log('\nNo tweets found in the past 24 hours with view count > 10,000.');
				await sendMessageToTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, '過去24小時內沒有發現瀏覽量超過10,000的推文');
			}
		} catch (error) {
			console.error('Error in scheduled job:', error);
			await sendMessageToTelegram(
				env.TELEGRAM_BOT_TOKEN,
				env.TELEGRAM_CHAT_ID,
				`監控過程中發生錯誤: ${error instanceof Error ? error.message : 'Unknown error'}`
			);
		}
	},

	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		try {
			// 處理 Telegram webhook
			if (request.method === 'POST') {
				const update: TelegramUpdate = await request.json();
				await handleTelegramMessage(update, env);
				return new Response('OK');
			}

			// 處理 GET 請求 - 手動查詢
			const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
			const { coreTweets, applicationTweets } = await getAllHighViewTweets(env.KAITO_API_KEY, supabase, env);
			return new Response(
				JSON.stringify({
					success: true,
					coreCount: coreTweets.length,
					applicationCount: applicationTweets.length,
					coreTweets: coreTweets,
					applicationTweets: applicationTweets,
				}),
				{
					headers: { 'Content-Type': 'application/json' },
				}
			);
		} catch (error) {
			return new Response(
				JSON.stringify({
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}
	},
};
