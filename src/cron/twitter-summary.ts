import { Env, ExecutionContext } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { callGeminiForAnalysis } from '../utils/ai';

function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles_test_core';
}

async function selectTopArticle(supabase: any, env: Env) {
	const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
	const table = getArticlesTable(env);

	const { data, error } = await supabase
		.from(table)
		.select('id, title, url, summary, summary_cn, published_date, source, tags, keywords, content')
		.gte('published_date', fourHoursAgo.toISOString())
		.order('published_date', { ascending: false })
		.limit(100);

	if (error) {
		console.error('[TWITTER-SUMMARY] fetch articles error:', error);
		return null;
	}

	if (!data || data.length === 0) return null;

	// simple scoring: prefer tags includes AI etc, and recency
	const importantKeywords = ['ai', 'artificial intelligence', 'openai', 'anthropic', 'google', 'meta', 'microsoft', 'nvidia', 'funding', 'ipo', 'acquisition'];
	const scored = data.map((article: any) => {
		let score = 0;
		const titleLower = (article.title || '').toLowerCase();
		const summaryLower = (article.summary || article.summary_cn || article.content || '').toLowerCase();
		importantKeywords.forEach((kw) => {
			if (titleLower.includes(kw)) score += 5;
			if (summaryLower.includes(kw)) score += 2;
		});
		const hoursOld = (Date.now() - new Date(article.published_date).getTime()) / (1000 * 60 * 60);
		if (hoursOld < 2) score += 5;
		else if (hoursOld < 6) score += 4;
		else if (hoursOld < 12) score += 3;
		else if (hoursOld < 24) score += 2;

		return { ...article, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored[0];
}

export async function handleTwitterSummaryCron(env: Env, _ctx: ExecutionContext) {
	console.log('[TWITTER-SUMMARY] cron trigger start');
	if (!env.OPENROUTER_API_KEY) {
		console.warn('[TWITTER-SUMMARY] OPENROUTER_API_KEY missing, skip');
		return;
	}

	const supabase = getSupabaseClient(env);
	const topArticle = await selectTopArticle(supabase, env);
	if (!topArticle) {
		console.log('[TWITTER-SUMMARY] no article in last 4h');
		return;
	}

	try {
		const analysis = await callGeminiForAnalysis(
			{
				id: topArticle.id,
				title: topArticle.title,
				title_cn: topArticle.title_cn,
				summary: topArticle.summary,
				summary_cn: topArticle.summary_cn,
				content: topArticle.content,
				url: topArticle.url,
				source: topArticle.source,
				published_date: topArticle.published_date,
				tags: topArticle.tags || [],
				keywords: topArticle.keywords || [],
			},
			env.OPENROUTER_API_KEY
		);

		console.log('[TWITTER-SUMMARY] Generated summary:', analysis.summary_en);
		// TODO: integrate actual Twitter posting if credentials are available
	} catch (err) {
		console.error('[TWITTER-SUMMARY] error generating summary:', err);
	}

	console.log('[TWITTER-SUMMARY] cron trigger end');
}
