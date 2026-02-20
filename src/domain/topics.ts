import { SupabaseClient } from '@supabase/supabase-js';
import { callOpenRouter, extractJson } from '../infra/ai';
import { logInfo, logWarn } from '../infra/log';

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

interface ArticleTopicRow {
	topic_id: string | null;
}

export interface TopicAssignmentResult {
	topicId: string | null;
	isNewTopic: boolean;
	articleCount: number;
	needsSynthesis: boolean;
}

function uniqueSortedIds(ids: string[]): string[] {
	return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function getArticleTopicId(
	supabase: SupabaseClient,
	table: string,
	articleId: string
): Promise<string | null> {
	const { data, error } = await supabase
		.from(table)
		.select('topic_id')
		.eq('id', articleId)
		.maybeSingle();

	if (error) {
		logWarn('TOPIC', 'Failed to get article topic', { articleId, error: error.message });
		return null;
	}

	return (data as ArticleTopicRow | null)?.topic_id ?? null;
}

async function attachArticleToTopic(
	supabase: SupabaseClient,
	table: string,
	articleId: string,
	topicId: string
): Promise<string | null> {
	const { error } = await supabase
		.from(table)
		.update({ topic_id: topicId })
		.eq('id', articleId)
		.is('topic_id', null);

	if (error) {
		logWarn('TOPIC', 'Failed to attach article to topic', { articleId, topicId, error: error.message });
	}

	return getArticleTopicId(supabase, table, articleId);
}

async function getAnyAssignedTopicId(
	supabase: SupabaseClient,
	table: string,
	articleIds: string[]
): Promise<string | null> {
	if (articleIds.length === 0) return null;

	const { data, error } = await supabase
		.from(table)
		.select('topic_id')
		.in('id', articleIds)
		.not('topic_id', 'is', null)
		.limit(1);

	if (error) {
		logWarn('TOPIC', 'Failed to re-check assigned topic in cluster', { error: error.message });
		return null;
	}

	return (data?.[0] as ArticleTopicRow | undefined)?.topic_id ?? null;
}

async function getTopicArticleCount(supabase: SupabaseClient, topicId: string): Promise<number> {
	const { data } = await supabase
		.from('topics')
		.select('article_count')
		.eq('id', topicId)
		.maybeSingle();

	return (data as { article_count: number } | null)?.article_count ?? 0;
}

async function cleanupTopicIfUnused(
	supabase: SupabaseClient,
	table: string,
	topicId: string
): Promise<void> {
	const { count, error: countError } = await supabase
		.from(table)
		.select('id', { count: 'exact', head: true })
		.eq('topic_id', topicId);

	if (countError) {
		logWarn('TOPIC', 'Failed to count topic usage for cleanup', { topicId, error: countError.message });
		return;
	}

	if ((count ?? 0) > 0) return;

	const { error: cleanupError } = await supabase
		.from('topics')
		.delete()
		.eq('id', topicId);

	if (cleanupError) {
		logWarn('TOPIC', 'Failed to cleanup unused topic', { topicId, error: cleanupError.message });
	}
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
		logInfo('TOPIC', 'Article not found or error', { articleId, error: fetchError?.message });
		return noResult;
	}

	const typedArticle = article as ArticleWithEmbedding;

	// Skip if no embedding or already has topic
	if (!typedArticle.embedding) {
		logInfo('TOPIC', 'Article has no embedding, skipping', { articleId });
		return noResult;
	}

	if (typedArticle.topic_id) {
		logInfo('TOPIC', 'Article already has topic', { articleId, topicId: typedArticle.topic_id });
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
		logWarn('TOPIC', 'RPC error', { articleId, error: rpcError.message });
		return noResult;
	}

	const candidates = (similar as SimilarArticle[]) || [];
	if (candidates.length === 0) {
		logInfo('TOPIC', 'No similar articles found', { articleId });
		return noResult;
	}

	logInfo('TOPIC', 'Found similar articles', { articleId, count: candidates.length });

	// 3. Check for existing topic among similar articles
	const withTopic = candidates.find((c) => c.topic_id);

	if (withTopic) {
		const finalTopicId = await attachArticleToTopic(supabase, table, articleId, withTopic.topic_id!);
		if (!finalTopicId) return noResult;

		await updateTopicStats(supabase, finalTopicId);
		const articleCount = await getTopicArticleCount(supabase, finalTopicId);
		const needsSynthesis = shouldSynthesizeTopic(articleCount, false);

		logInfo('TOPIC', 'Assigned article to existing topic', { articleId, topicId: finalTopicId, articleCount });

		return {
			topicId: finalTopicId,
			isNewTopic: false,
			articleCount,
			needsSynthesis,
		};
	} else {
		const allIds = uniqueSortedIds([articleId, ...candidates.map((c) => c.article_id)]);
		const lockArticleId = allIds[0];
		if (!lockArticleId) return noResult;

		// Re-check before creating, because another workflow may have assigned a topic already.
		const racedTopicId = await getAnyAssignedTopicId(supabase, table, allIds);
		if (racedTopicId) {
			const finalTopicId = await attachArticleToTopic(supabase, table, articleId, racedTopicId);
			if (!finalTopicId) return noResult;

			await updateTopicStats(supabase, finalTopicId);
			const articleCount = await getTopicArticleCount(supabase, finalTopicId);
			const needsSynthesis = shouldSynthesizeTopic(articleCount, false);

			logInfo('TOPIC', 'Joined topic created by concurrent workflow', {
				articleId,
				topicId: finalTopicId,
				lockArticleId,
			});

			return {
				topicId: finalTopicId,
				isNewTopic: false,
				articleCount,
				needsSynthesis,
			};
		}

		// Create new topic with deterministic canonical article to reduce split races.
		const expectedArticleCount = allIds.length;
		const { data: topic, error: createError } = await supabase
			.from('topics')
			.insert({
				title: typedArticle.title,
				title_cn: typedArticle.title_cn,
				canonical_article_id: lockArticleId,
				article_count: expectedArticleCount,
			})
			.select('id')
			.single();

		if (createError || !topic) {
			logWarn('TOPIC', 'Failed to create topic', { error: createError?.message });
			return noResult;
		}
		const topicId = (topic as { id: string }).id;

		// Cluster lock: only one worker should claim the same lock article.
		const { data: lockClaim, error: lockClaimError } = await supabase
			.from(table)
			.update({ topic_id: topicId })
			.eq('id', lockArticleId)
			.is('topic_id', null)
			.select('id')
			.maybeSingle();

		if (lockClaimError) {
			logWarn('TOPIC', 'Failed to claim lock article for topic creation', {
				articleId,
				topicId,
				lockArticleId,
				error: lockClaimError.message,
			});
			await cleanupTopicIfUnused(supabase, table, topicId);
			return noResult;
		}

		if (!lockClaim) {
			// Lost race: another worker assigned cluster first.
			await cleanupTopicIfUnused(supabase, table, topicId);

			const winnerTopicId = await getArticleTopicId(supabase, table, lockArticleId);
			if (!winnerTopicId) return noResult;

			const finalTopicId = await attachArticleToTopic(supabase, table, articleId, winnerTopicId);
			if (!finalTopicId) return noResult;

			await updateTopicStats(supabase, winnerTopicId);
			const articleCount = await getTopicArticleCount(supabase, winnerTopicId);
			const needsSynthesis = shouldSynthesizeTopic(articleCount, false);

			logInfo('TOPIC', 'Lost topic creation race and joined winner topic', {
				articleId,
				winnerTopicId,
				lockArticleId,
			});

			return {
				topicId: finalTopicId,
				isNewTopic: false,
				articleCount,
				needsSynthesis,
			};
		}

		// Assign remaining similar articles + current article to the new topic without overwriting existing assignments.
		const peerIds = allIds.filter((id) => id !== lockArticleId);
		const { error: batchUpdateError } = peerIds.length === 0
			? { error: null as null | { message: string } }
			: await supabase
			.from(table)
			.update({ topic_id: topicId })
			.in('id', peerIds)
			.is('topic_id', null);

		if (batchUpdateError) {
			logWarn('TOPIC', 'Failed to batch update peer articles', { topicId, error: batchUpdateError.message });
		}

		const finalTopicId = await attachArticleToTopic(supabase, table, articleId, topicId);
		if (!finalTopicId) {
			await cleanupTopicIfUnused(supabase, table, topicId);
			return noResult;
		}

		// Recompute topic stats from actual assigned articles (count + first/last seen timestamps).
		await updateTopicStats(supabase, finalTopicId);

		const actualArticleCount = await getTopicArticleCount(supabase, finalTopicId);
		const isNewTopic = finalTopicId === topicId;
		const needsSynthesis = shouldSynthesizeTopic(actualArticleCount, isNewTopic);
		if (!isNewTopic) {
			await cleanupTopicIfUnused(supabase, table, topicId);
		}
		logInfo('TOPIC', 'Created new topic', { topicId: finalTopicId, articleCount: actualArticleCount, isNewTopic });

		return {
			topicId: finalTopicId,
			isNewTopic,
			articleCount: actualArticleCount,
			needsSynthesis,
		};
	}
}

async function updateTopicStats(supabase: SupabaseClient, topicId: string): Promise<void> {
	const { error } = await supabase.rpc('update_topic_stats', { p_topic_id: topicId });
	if (error) {
		logWarn('TOPIC', 'Failed to update topic stats', { error: error.message });
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
	logInfo('TOPIC', 'Synthesizing summary for topic', { topicId });

	// Fetch all articles for this topic
	const { data: articles, error: fetchError } = await supabase
		.from(table)
		.select('title, title_cn, summary, summary_cn, tags, source')
		.eq('topic_id', topicId)
		.order('published_date', { ascending: false })
		.limit(20); // Limit to avoid prompt overflow

	if (fetchError || !articles?.length) {
		logWarn('TOPIC', 'Failed to fetch articles for topic', { topicId, error: fetchError?.message });
		return false;
	}

	const typedArticles = articles as TopicArticle[];
	logInfo('TOPIC', 'Found articles for synthesis', { topicId, count: typedArticles.length });

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
		logWarn('TOPIC', 'AI synthesis failed for topic', { topicId });
		return false;
	}

	// Parse response
	const result = extractJson<SynthesizedTopic>(rawContent);
	if (!result || !result.title || !result.title_cn) {
		logWarn('TOPIC', 'Invalid synthesis response for topic', { topicId });
		return false;
	}

	logInfo('TOPIC', 'Synthesized topic title', { topicId, title: result.title, title_cn: result.title_cn });

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
		logWarn('TOPIC', 'Failed to update topic', { topicId, error: updateError.message });
		return false;
	}

	logInfo('TOPIC', 'Successfully updated topic with synthesized summary', { topicId });
	return true;
}

/**
 * Checks if a topic should be re-synthesized based on article count thresholds.
 */
export function shouldSynthesizeTopic(articleCount: number, isNewTopic: boolean): boolean {
	if (isNewTopic && articleCount >= 2) return true;
	return (TOPIC_CONFIG.SYNTHESIZE_THRESHOLDS as readonly number[]).includes(articleCount);
}
