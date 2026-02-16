import { SupabaseClient } from '@supabase/supabase-js';
import { callOpenRouter, extractJson } from '../infra/ai';

const TOPIC_CONFIG = {
	SIMILARITY_THRESHOLD: 0.85,
	TIME_WINDOW_DAYS: 7,
	MAX_SIMILAR_RESULTS: 10,
	SYNTHESIZE_THRESHOLDS: [2, 3, 5, 10], // Re-synthesize when article count reaches these
} as const;

interface SimilarArticle {
	article_id: string;
	topic_id: string | null;
	similarity: number;
}

interface ArticleWithEmbedding {
	id: string;
	title: string;
	title_cn?: string | null;
	embedding: number[] | null;
	topic_id?: string | null;
}

export interface TopicAssignmentResult {
	topicId: string | null;
	isNewTopic: boolean;
	articleCount: number;
	needsSynthesis: boolean;
}

/**
 * Assigns an article to a topic based on embedding similarity.
 * - If similar articles exist with a topic, joins that topic
 * - If similar articles exist without a topic, creates a new topic and assigns all
 * - If no similar articles, does nothing (article remains topicless)
 *
 * Returns info about the assignment for synthesis decisions.
 */
export async function assignArticleTopic(
	supabase: SupabaseClient,
	articleId: string,
	table: string
): Promise<TopicAssignmentResult> {
	const noResult: TopicAssignmentResult = {
		topicId: null,
		isNewTopic: false,
		articleCount: 0,
		needsSynthesis: false,
	};
	// 1. Get article with embedding
	const { data: article, error: fetchError } = await supabase
		.from(table)
		.select('id, title, title_cn, embedding, topic_id')
		.eq('id', articleId)
		.single();

	if (fetchError || !article) {
		console.log(`[TOPIC] Article ${articleId} not found or error: ${fetchError?.message}`);
		return noResult;
	}

	const typedArticle = article as ArticleWithEmbedding;

	// Skip if no embedding or already has topic
	if (!typedArticle.embedding) {
		console.log(`[TOPIC] Article ${articleId} has no embedding, skipping`);
		return noResult;
	}

	if (typedArticle.topic_id) {
		console.log(`[TOPIC] Article ${articleId} already has topic ${typedArticle.topic_id}`);
		return noResult;
	}

	// 2. Find similar articles using the RPC function
	const { data: similar, error: rpcError } = await supabase.rpc('find_similar_articles_with_topics', {
		target_embedding: typedArticle.embedding,
		similarity_threshold: TOPIC_CONFIG.SIMILARITY_THRESHOLD,
		time_window_days: TOPIC_CONFIG.TIME_WINDOW_DAYS,
		result_limit: TOPIC_CONFIG.MAX_SIMILAR_RESULTS,
		exclude_article_id: articleId,
	});

	if (rpcError) {
		console.warn(`[TOPIC] RPC error for ${articleId}: ${rpcError.message}`);
		return noResult;
	}

	const candidates = (similar as SimilarArticle[]) || [];
	if (candidates.length === 0) {
		console.log(`[TOPIC] No similar articles found for ${articleId}`);
		return noResult;
	}

	console.log(`[TOPIC] Found ${candidates.length} similar articles for ${articleId}`);

	// 3. Check for existing topic among similar articles
	const withTopic = candidates.find((c) => c.topic_id);

	if (withTopic) {
		// Join existing topic
		const { error: updateError } = await supabase
			.from(table)
			.update({ topic_id: withTopic.topic_id })
			.eq('id', articleId);

		if (updateError) {
			console.warn(`[TOPIC] Failed to assign topic: ${updateError.message}`);
			return noResult;
		}

		// Update topic stats and get new count
		await updateTopicStats(supabase, withTopic.topic_id!);

		// Get updated article count
		const { data: topicData } = await supabase
			.from('topics')
			.select('article_count')
			.eq('id', withTopic.topic_id)
			.single();

		const articleCount = (topicData as { article_count: number } | null)?.article_count ?? 0;
		const needsSynthesis = shouldSynthesizeTopic(articleCount, false);

		console.log(`[TOPIC] Assigned article ${articleId} to existing topic ${withTopic.topic_id} (count: ${articleCount})`);

		return {
			topicId: withTopic.topic_id!,
			isNewTopic: false,
			articleCount,
			needsSynthesis,
		};
	} else {
		// Create new topic with this article as canonical
		const articleCount = candidates.length + 1;
		const { data: topic, error: createError } = await supabase
			.from('topics')
			.insert({
				title: typedArticle.title,
				title_cn: typedArticle.title_cn,
				canonical_article_id: articleId,
				article_count: articleCount,
			})
			.select('id')
			.single();

		if (createError || !topic) {
			console.warn(`[TOPIC] Failed to create topic: ${createError?.message}`);
			return noResult;
		}
		const topicId = (topic as { id: string }).id;

		// Assign all similar articles + current article to the new topic
		const allIds = [articleId, ...candidates.map((c) => c.article_id)];
		const { error: batchUpdateError } = await supabase
			.from(table)
			.update({ topic_id: topicId })
			.in('id', allIds);

		if (batchUpdateError) {
			console.warn(`[TOPIC] Failed to batch update articles: ${batchUpdateError.message}`);
			const { error: cleanupError } = await supabase
				.from('topics')
				.delete()
				.eq('id', topicId);
			if (cleanupError) {
				console.warn(`[TOPIC] Failed to cleanup orphan topic ${topicId}: ${cleanupError.message}`);
			}
			return noResult;
		}

		// Recompute topic stats from actual assigned articles (count + first/last seen timestamps).
		await updateTopicStats(supabase, topicId);

		const { data: topicData } = await supabase
			.from('topics')
			.select('article_count')
			.eq('id', topicId)
			.single();

		const actualArticleCount = (topicData as { article_count: number } | null)?.article_count ?? articleCount;
		const needsSynthesis = shouldSynthesizeTopic(actualArticleCount, true);
		console.log(`[TOPIC] Created new topic ${topicId} with ${actualArticleCount} articles`);

		return {
			topicId,
			isNewTopic: true,
			articleCount: actualArticleCount,
			needsSynthesis,
		};
	}
}

async function updateTopicStats(supabase: SupabaseClient, topicId: string): Promise<void> {
	const { error } = await supabase.rpc('update_topic_stats', { p_topic_id: topicId });
	if (error) {
		console.warn(`[TOPIC] Failed to update topic stats: ${error.message}`);
	}
}

// ─────────────────────────────────────────────────────────────
// Topic Summary Synthesis
// ─────────────────────────────────────────────────────────────

interface TopicArticle {
	title: string;
	title_cn: string | null;
	summary: string | null;
	summary_cn: string | null;
	tags: string[] | null;
	source: string;
}

interface SynthesizedTopic {
	title: string;
	title_cn: string;
	description: string;
	description_cn: string;
}

const TOPIC_SYNTHESIS_PROMPT = `你是一位專業的新聞編輯。請根據以下關於同一事件/主題的多篇新聞文章，生成一個統一的主題標題和描述。

【文章列表】
{articles}

【任務】
1. 分析這些文章的共同主題
2. 生成一個概括性的主題標題（不要直接複製某篇文章的標題）
3. 生成一個簡短的主題描述（1-2句話）

【要求】
- 標題要簡潔有力，2-8個詞（英文）或 5-15 字（中文）
- 描述要概括整體事件，而不是描述單篇文章
- 使用中立的新聞語氣
- 英文和繁體中文版本都要提供

【回傳 JSON】
{
  "title": "English topic title",
  "title_cn": "繁體中文主題標題",
  "description": "English description in 1-2 sentences",
  "description_cn": "繁體中文描述，1-2句話"
}

只回傳 JSON，不要其他文字。`;

function buildArticleListForPrompt(articles: TopicArticle[]): string {
	return articles
		.map((a, i) => {
			const parts = [`${i + 1}. 標題: ${a.title_cn || a.title}`];
			if (a.summary_cn || a.summary) {
				parts.push(`   摘要: ${(a.summary_cn || a.summary)?.substring(0, 200)}`);
			}
			if (a.tags?.length) {
				parts.push(`   標籤: ${a.tags.slice(0, 5).join(', ')}`);
			}
			parts.push(`   來源: ${a.source}`);
			return parts.join('\n');
		})
		.join('\n\n');
}

/**
 * Synthesizes a topic title and description from all its articles using AI.
 * Called when a topic is created or reaches certain article count thresholds.
 */
export async function synthesizeTopicSummary(
	supabase: SupabaseClient,
	topicId: string,
	table: string,
	apiKey: string
): Promise<boolean> {
	console.log(`[TOPIC] Synthesizing summary for topic ${topicId}`);

	// Fetch all articles for this topic
	const { data: articles, error: fetchError } = await supabase
		.from(table)
		.select('title, title_cn, summary, summary_cn, tags, source')
		.eq('topic_id', topicId)
		.order('published_date', { ascending: false })
		.limit(20); // Limit to avoid prompt overflow

	if (fetchError || !articles?.length) {
		console.warn(`[TOPIC] Failed to fetch articles for topic ${topicId}: ${fetchError?.message}`);
		return false;
	}

	const typedArticles = articles as TopicArticle[];
	console.log(`[TOPIC] Found ${typedArticles.length} articles for synthesis`);

	// Build prompt
	const articleList = buildArticleListForPrompt(typedArticles);
	const prompt = TOPIC_SYNTHESIS_PROMPT.replace('{articles}', articleList);

	// Call AI
	const rawContent = await callOpenRouter(prompt, {
		apiKey,
		maxTokens: 500,
		temperature: 0.3,
	});

	if (!rawContent) {
		console.warn(`[TOPIC] AI synthesis failed for topic ${topicId}`);
		return false;
	}

	// Parse response
	const result = extractJson<SynthesizedTopic>(rawContent);
	if (!result || !result.title || !result.title_cn) {
		console.warn(`[TOPIC] Invalid synthesis response for topic ${topicId}`);
		return false;
	}

	console.log(`[TOPIC] Synthesized: "${result.title_cn}" / "${result.title}"`);

	// Update topic
	const { error: updateError } = await supabase
		.from('topics')
		.update({
			title: result.title,
			title_cn: result.title_cn,
			description: result.description,
			description_cn: result.description_cn,
			updated_at: new Date().toISOString(),
		})
		.eq('id', topicId);

	if (updateError) {
		console.warn(`[TOPIC] Failed to update topic ${topicId}: ${updateError.message}`);
		return false;
	}

	console.log(`[TOPIC] Successfully updated topic ${topicId} with synthesized summary`);
	return true;
}

/**
 * Checks if a topic should be re-synthesized based on article count thresholds.
 */
export function shouldSynthesizeTopic(articleCount: number, isNewTopic: boolean): boolean {
	if (isNewTopic && articleCount >= 2) return true;
	return (TOPIC_CONFIG.SYNTHESIZE_THRESHOLDS as readonly number[]).includes(articleCount);
}
