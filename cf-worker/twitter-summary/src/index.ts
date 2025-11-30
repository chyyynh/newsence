import { createClient } from '@supabase/supabase-js';
import { postThread } from './twitter';
import { selectTopArticle, generateTwitterSummary } from './utils';

interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	TWITTER_CLIENT_ID: string;
	TWITTER_CLIENT_SECRET: string;
	TWITTER_KV: KVNamespace;
	OPENROUTER_API_KEY: string;
}

export default {
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log('Starting Twitter summary worker...');
		
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

		try {
			console.log('=== Twitter Summary Worker Started ===');
			
			// 檢查是否有最近4小時內已發布的文章，避免重複
			const recentPosts = await supabase
				.from('twitter_posts')
				.select('posted_at')
				.gte('posted_at', new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString())
				.order('posted_at', { ascending: false })
				.limit(1);

			if (recentPosts.data && recentPosts.data.length > 0) {
				console.log(`Recent Twitter post found at ${recentPosts.data[0].posted_at}, skipping this run`);
				return;
			}
			
			// 選擇過去4小時內最重要的文章
			const topArticle = await selectTopArticle(supabase);
			
			if (!topArticle) {
				console.log('No suitable articles found in the last 4 hours for Twitter summary');
				return;
			}

			console.log(`Selected article for Twitter:`);
			console.log(`  Title: ${topArticle.title}`);
			console.log(`  Source: ${topArticle.source}`);
			console.log(`  Score: ${topArticle.score}`);
			console.log(`  Published: ${topArticle.published_date}`);
			
			// 生成專門用於 Twitter 的總結
			console.log('Generating Twitter summary with Gemini 2.5 Flash Lite...');
			console.log('Debug - OpenRouter API Key:', env.OPENROUTER_API_KEY ? `${env.OPENROUTER_API_KEY.substring(0, 20)}...` : 'MISSING');
			const twitterSummary = await generateTwitterSummary(topArticle, env.OPENROUTER_API_KEY);
			
			console.log(`Generated summary: "${twitterSummary}"`);
			
			// 發布到 Twitter
			console.log('Posting to Twitter...');
			const tweetIds = await postThread(env, twitterSummary);
			
			console.log(`Twitter summary posted successfully! Tweet IDs: ${tweetIds.join(', ')}`);
			
			// 記錄到資料庫以避免重複發布
			await recordPostedArticle(supabase, topArticle.id, tweetIds, twitterSummary, topArticle.score);
			
			console.log('=== Twitter Summary Worker Completed Successfully ===');

		} catch (error) {
			console.error('=== Twitter Summary Worker Error ===');
			console.error('Error details:', error);
			
			if (error instanceof Error) {
				console.error('Error message:', error.message);
				console.error('Error stack:', error.stack);
			}
			
			// 可選：發送錯誤通知
			// 這裡可以加入發送錯誤通知到 Telegram 或其他監控系統的邏輯
		}
	},
};

async function recordPostedArticle(
	supabase: any, 
	articleId: string, 
	tweetIds: string[], 
	tweetContent: string, 
	articleScore: number
) {
	try {
		const { error } = await supabase
			.from('twitter_posts')
			.insert({
				article_id: articleId,
				tweet_ids: tweetIds,
				tweet_content: tweetContent,
				article_score: articleScore,
				posted_at: new Date().toISOString()
			});
		
		if (error) {
			console.error('Error recording posted article:', error);
		} else {
			console.log('Successfully recorded posted article to database');
		}
	} catch (err) {
		console.error('Error in recordPostedArticle:', err);
	}
}