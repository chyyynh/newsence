import { getSupabaseClient } from '../utils/supabase';
import { prepareArticleTextForEmbedding, generateArticleEmbedding, saveArticleEmbedding } from '../utils/embedding';
import { Article, Env, ExecutionContext, MessageBatch, QueueMessage } from '../types';
import { getProcessor, ProcessorContext } from '../processors';

const ARTICLE_FIELDS = 'id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url, platform_metadata';
const PROCESSING_DELAY_MS = 200;

function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles_test_core';
}

async function fetchArticlesForProcessing(supabase: any, table: string, articleIds?: string[]): Promise<Article[]> {
	if (articleIds?.length) {
		const { data, error } = await supabase.from(table).select(ARTICLE_FIELDS).in('id', articleIds);
		if (error) throw new Error(`Error fetching specific articles: ${error.message}`);
		return data ?? [];
	}

	const timeframe = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	const { data, error } = await supabase
		.from(table)
		.select(ARTICLE_FIELDS)
		.gte('scraped_date', timeframe)
		.or('tags.is.null,keywords.is.null,title_cn.is.null,summary_cn.is.null,summary.is.null,title_cn.eq.,summary_cn.eq.,summary.eq.')
		.order('scraped_date', { ascending: false });

	if (error) throw new Error(`Error fetching articles needing processing: ${error.message}`);
	return data ?? [];
}

async function processSingleArticle(supabase: any, env: Env, table: string, article: Article): Promise<boolean> {
	const processor = getProcessor(article.source_type);
	const ctx: ProcessorContext = { env, supabase, table };

	console.log(`[ARTICLE] Using ${processor.sourceType} processor for ${article.source_type || 'unknown'}`);

	const result = await processor.process(article, ctx);

	// 更新文章欄位
	if (Object.keys(result.updateData).length > 0) {
		const { error } = await supabase.from(table).update(result.updateData).eq('id', article.id);
		if (error) {
			console.error(`[ARTICLE] Error updating ${article.id}:`, error);
			return false;
		}
		console.log(`[ARTICLE] Updated: ${Object.keys(result.updateData).join(', ')}`);
	}

	// 更新 platform_metadata.enrichments
	if (result.enrichments && Object.keys(result.enrichments).length > 0) {
		const existingMetadata = article.platform_metadata || {};
		const updatedMetadata = {
			...existingMetadata,
			enrichments: {
				...(existingMetadata.enrichments || {}),
				...result.enrichments,
				processedAt: new Date().toISOString(),
			},
		};

		const { error } = await supabase.from(table).update({ platform_metadata: updatedMetadata }).eq('id', article.id);
		if (error) {
			console.error(`[ARTICLE] Error updating enrichments for ${article.id}:`, error);
		} else {
			console.log(`[ARTICLE] Enrichments saved: ${Object.keys(result.enrichments).join(', ')}`);
		}
	}

	// 生成 Embedding
	const embeddingText = prepareArticleTextForEmbedding({
		title: article.title,
		title_cn: result.updateData.title_cn ?? article.title_cn,
		summary: result.updateData.summary ?? article.summary,
		summary_cn: result.updateData.summary_cn ?? article.summary_cn,
	});

	if (embeddingText && env.AI) {
		const embedding = await generateArticleEmbedding(embeddingText, env.AI);
		if (embedding) {
			const saved = await saveArticleEmbedding(supabase, article.id, embedding);
			console.log(`[ARTICLE] Embedding ${saved ? 'saved' : 'failed'} (${embedding.length} dims)`);
		}
	}

	return true;
}

export async function processArticlesByIds(env: Env, articleIds?: string[]): Promise<void> {
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);
	const articles = await fetchArticlesForProcessing(supabase, table, articleIds);

	if (!articles.length) {
		console.log('[ARTICLE] No articles need processing');
		return;
	}

	console.log(`[ARTICLE] Found ${articles.length} articles for AI processing`);

	let processedCount = 0;
	let errorCount = 0;

	for (let i = 0; i < articles.length; i++) {
		const article = articles[i];
		console.log(`[ARTICLE] Processing ${i + 1}/${articles.length} - ${article.id}: ${article.title?.substring(0, 60) ?? 'Untitled'}...`);

		try {
			const success = await processSingleArticle(supabase, env, table, article);
			if (success) {
				processedCount++;
				console.log(`[ARTICLE] Completed ${article.id}`);
			} else {
				errorCount++;
			}
			await new Promise((resolve) => setTimeout(resolve, PROCESSING_DELAY_MS));
		} catch (err) {
			console.error(`[ARTICLE] Error processing ${article.id}:`, err);
			errorCount++;
		}
	}

	console.log(`[ARTICLE] Summary: total=${articles.length}, success=${processedCount}, errors=${errorCount}`);
}

export async function handleArticleQueue(
	batch: MessageBatch<QueueMessage>,
	env: Env,
	ctx: ExecutionContext
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;

		if (!body || body.type !== 'process_articles') {
			console.warn(`[ARTICLE-QUEUE] Invalid message: ${body ? `unknown type '${body.type}'` : 'empty body'}`);
			message.ack();
			continue;
		}

		try {
			const ids = body.article_ids ?? [];
			console.log(`[ARTICLE-QUEUE] Processing ${ids.length} articles from ${body.triggered_by ?? 'unknown'}`);
			ctx.waitUntil(processArticlesByIds(env, ids));
			message.ack();
		} catch (err) {
			console.error('[ARTICLE-QUEUE] Error, retrying:', err);
			message.retry();
		}
	}
}
