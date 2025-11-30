import { getSupabaseClient } from '../utils/supabase';
import { callGeminiForAnalysis } from '../utils/ai';
import {
	Article,
	Env,
	ExecutionContext,
	MessageBatch,
	QueueMessage,
} from '../types';

function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles_test_core';
}

async function fetchArticlesForProcessing(supabase: any, table: string, articleIds?: string[]) {
	if (articleIds && articleIds.length > 0) {
		const { data, error } = await supabase
			.from(table)
			.select('id, title, title_cn, summary, summary_cn, content, url, source, published_date, tags, keywords, scraped_date')
			.in('id', articleIds);

		if (error) {
			throw new Error(`Error fetching specific articles: ${error.message}`);
		}

		return data || [];
	}

	// Default: process recent/unprocessed articles from last 24h
	const timeframe = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const { data, error } = await supabase
		.from(table)
		.select('id, title, title_cn, summary, summary_cn, content, url, source, published_date, tags, keywords, scraped_date')
		.gte('scraped_date', timeframe)
		.or('tags.is.null,keywords.is.null,title_cn.is.null,summary_cn.is.null,summary.is.null,title_cn.eq.,summary_cn.eq.,summary.eq.')
		.order('scraped_date', { ascending: false });

	if (error) {
		throw new Error(`Error fetching articles needing processing: ${error.message}`);
	}

	return data || [];
}

export async function processArticlesByIds(env: Env, articleIds?: string[]): Promise<void> {
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);
	const articles = await fetchArticlesForProcessing(supabase, table, articleIds);

	if (!articles || articles.length === 0) {
		console.log('[ARTICLE] No articles need processing');
		return;
	}

	console.log(`[ARTICLE] Found ${articles.length} articles that need AI processing`);

	let processedCount = 0;
	let errorCount = 0;

	for (let i = 0; i < articles.length; i++) {
		const article: Article = articles[i];
		try {
			console.log(`[ARTICLE] Processing ${i + 1}/${articles.length} - ${article.id}: ${article.title?.substring(0, 60) || 'Untitled'}...`);

			const analysis = await callGeminiForAnalysis(article, env.OPENROUTER_API_KEY);
			const allTags = [...analysis.tags, analysis.category].filter((v, idx, arr) => arr.indexOf(v) === idx);

			const updateData: Record<string, any> = { content: null };

			if (!article.tags || article.tags.length === 0) {
				updateData.tags = allTags;
			}
			if (!article.keywords || article.keywords.length === 0) {
				updateData.keywords = analysis.keywords;
			}
			if (!article.title_cn || article.title_cn.trim() === '') {
				updateData.title_cn = analysis.title_cn;
			}
			if (!article.summary || article.summary.trim() === '') {
				updateData.summary = analysis.summary_en;
			}
			if (!article.summary_cn || article.summary_cn.trim() === '') {
				updateData.summary_cn = analysis.summary_cn;
			}
			if (analysis.title_en && !article.title_cn) {
				updateData.title = analysis.title_en;
			}

			// If only content is being nulled, avoid unnecessary update
			if (Object.keys(updateData).length === 1 && updateData.content === null) {
				console.log(`[ARTICLE] Article ${article.id} already processed, skipping`);
				processedCount++;
				continue;
			}

			const { error: updateError } = await supabase.from(table).update(updateData).eq('id', article.id);

			if (updateError) {
				console.error(`[ARTICLE] Error updating article ${article.id}:`, updateError);
				errorCount++;
			} else {
				processedCount++;
				console.log(`[ARTICLE] ✅ Updated article ${article.id}`);
			}

			// Small delay to avoid rate limiting
			await new Promise((resolve) => setTimeout(resolve, 200));
		} catch (err) {
			console.error(`[ARTICLE] Error processing article ${article.id}:`, err);
			errorCount++;
		}
	}

	console.log(`[ARTICLE] Processing Summary -> total: ${articles.length}, success: ${processedCount}, errors: ${errorCount}`);
}

export async function handleArticleQueue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
	for (const message of batch.messages) {
		try {
			const body = message.body as QueueMessage | undefined;

			if (!body) {
				console.warn('[ARTICLE-QUEUE] Received empty message body, acknowledging');
				message.ack();
				continue;
			}

			if (body.type !== 'process_articles') {
				console.warn('[ARTICLE-QUEUE] Unknown message type:', body.type);
				message.ack();
				continue;
			}

			const ids = body.article_ids || [];
			console.log(`[ARTICLE-QUEUE] Processing request for ${ids.length} articles from ${body.triggered_by || 'unknown'}`);

			ctx.waitUntil(processArticlesByIds(env, ids));
			message.ack();
		} catch (err) {
			console.error('[ARTICLE-QUEUE] Error processing message, retrying:', err);
			message.retry();
		}
	}
}
