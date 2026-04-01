import type { Client } from 'pg';
import { logInfo, logWarn } from '../infra/log';
import { callOpenRouter, extractJson } from '../infra/openrouter';

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

async function getArticleTopicId(db: Client, table: string, articleId: string): Promise<string | null> {
	try {
		const result = await db.query(`SELECT topic_id FROM ${table} WHERE id = $1 LIMIT 1`, [articleId]);
		return (result.rows[0] as ArticleTopicRow | undefined)?.topic_id ?? null;
	} catch (error) {
		logWarn('TOPIC', 'Failed to get article topic', { articleId, error: (error as Error).message });
		return null;
	}
}

async function attachArticleToTopic(db: Client, table: string, articleId: string, topicId: string): Promise<string | null> {
	try {
		await db.query(`UPDATE ${table} SET topic_id = $1 WHERE id = $2 AND topic_id IS NULL`, [topicId, articleId]);
	} catch (error) {
		logWarn('TOPIC', 'Failed to attach article to topic', { articleId, topicId, error: (error as Error).message });
	}

	return getArticleTopicId(db, table, articleId);
}

async function getAnyAssignedTopicId(db: Client, table: string, articleIds: string[]): Promise<string | null> {
	if (articleIds.length === 0) return null;

	try {
		const result = await db.query(`SELECT topic_id FROM ${table} WHERE id = ANY($1) AND topic_id IS NOT NULL LIMIT 1`, [articleIds]);
		return (result.rows[0] as ArticleTopicRow | undefined)?.topic_id ?? null;
	} catch (error) {
		logWarn('TOPIC', 'Failed to re-check assigned topic in cluster', { error: (error as Error).message });
		return null;
	}
}

async function getTopicArticleCount(db: Client, topicId: string): Promise<number> {
	try {
		const result = await db.query('SELECT article_count FROM topics WHERE id = $1 LIMIT 1', [topicId]);
		return (result.rows[0] as { article_count: number } | undefined)?.article_count ?? 0;
	} catch (_error) {
		return 0;
	}
}

async function cleanupTopicIfUnused(db: Client, table: string, topicId: string): Promise<void> {
	try {
		const countResult = await db.query(`SELECT COUNT(*) FROM ${table} WHERE topic_id = $1`, [topicId]);
		const count = parseInt((countResult.rows[0] as { count: string }).count, 10);

		if (count > 0) return;

		await db.query('DELETE FROM topics WHERE id = $1', [topicId]);
	} catch (error) {
		logWarn('TOPIC', 'Failed to cleanup unused topic', { topicId, error: (error as Error).message });
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
export async function assignArticleTopic(db: Client, articleId: string, table: string): Promise<TopicAssignmentResult> {
	const noResult: TopicAssignmentResult = {
		topicId: null,
		isNewTopic: false,
		articleCount: 0,
		needsSynthesis: false,
	};
	// 1. Get article with embedding
	let typedArticle: ArticleWithEmbedding;
	try {
		const result = await db.query(`SELECT id, title, title_cn, embedding, topic_id FROM ${table} WHERE id = $1`, [articleId]);
		if (result.rows.length === 0) {
			logInfo('TOPIC', 'Article not found or error', { articleId });
			return noResult;
		}
		typedArticle = result.rows[0] as ArticleWithEmbedding;
	} catch (error) {
		logInfo('TOPIC', 'Article not found or error', { articleId, error: (error as Error).message });
		return noResult;
	}

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
	let candidates: SimilarArticle[];
	try {
		const embeddingStr = typeof typedArticle.embedding === 'string' ? typedArticle.embedding : `[${typedArticle.embedding.join(',')}]`;
		const result = await db.query('SELECT * FROM find_similar_articles_with_topics($1, $2, $3, $4, $5)', [
			embeddingStr,
			TOPIC_CONFIG.SIMILARITY_THRESHOLD,
			TOPIC_CONFIG.TIME_WINDOW_DAYS,
			TOPIC_CONFIG.MAX_SIMILAR_RESULTS,
			articleId,
		]);
		candidates = (result.rows as SimilarArticle[]) || [];
	} catch (error) {
		logWarn('TOPIC', 'RPC error', { articleId, error: (error as Error).message });
		return noResult;
	}

	if (candidates.length === 0) {
		logInfo('TOPIC', 'No similar articles found', { articleId });
		return noResult;
	}

	logInfo('TOPIC', 'Found similar articles', { articleId, count: candidates.length });

	// 3. Check for existing topic among similar articles
	const withTopic = candidates.find((c) => c.topic_id);

	if (withTopic) {
		const finalTopicId = await attachArticleToTopic(db, table, articleId, withTopic.topic_id!);
		if (!finalTopicId) return noResult;

		await updateTopicStats(db, finalTopicId);
		const articleCount = await getTopicArticleCount(db, finalTopicId);
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
		const racedTopicId = await getAnyAssignedTopicId(db, table, allIds);
		if (racedTopicId) {
			const finalTopicId = await attachArticleToTopic(db, table, articleId, racedTopicId);
			if (!finalTopicId) return noResult;

			await updateTopicStats(db, finalTopicId);
			const articleCount = await getTopicArticleCount(db, finalTopicId);
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
		let topicId: string;
		try {
			const result = await db.query(
				'INSERT INTO topics (title, title_cn, canonical_article_id, article_count) VALUES ($1, $2, $3, $4) RETURNING id',
				[typedArticle.title, typedArticle.title_cn, lockArticleId, expectedArticleCount],
			);
			if (result.rows.length === 0) {
				logWarn('TOPIC', 'Failed to create topic', {});
				return noResult;
			}
			topicId = (result.rows[0] as { id: string }).id;
		} catch (error) {
			logWarn('TOPIC', 'Failed to create topic', { error: (error as Error).message });
			return noResult;
		}

		// Cluster lock: only one worker should claim the same lock article.
		let lockClaim: { id: string } | null;
		try {
			const result = await db.query(`UPDATE ${table} SET topic_id = $1 WHERE id = $2 AND topic_id IS NULL RETURNING id`, [
				topicId,
				lockArticleId,
			]);
			lockClaim = (result.rows[0] as { id: string } | undefined) ?? null;
		} catch (error) {
			logWarn('TOPIC', 'Failed to claim lock article for topic creation', {
				articleId,
				topicId,
				lockArticleId,
				error: (error as Error).message,
			});
			await cleanupTopicIfUnused(db, table, topicId);
			return noResult;
		}

		if (!lockClaim) {
			// Lost race: another worker assigned cluster first.
			await cleanupTopicIfUnused(db, table, topicId);

			const winnerTopicId = await getArticleTopicId(db, table, lockArticleId);
			if (!winnerTopicId) return noResult;

			const finalTopicId = await attachArticleToTopic(db, table, articleId, winnerTopicId);
			if (!finalTopicId) return noResult;

			await updateTopicStats(db, winnerTopicId);
			const articleCount = await getTopicArticleCount(db, winnerTopicId);
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
		if (peerIds.length > 0) {
			try {
				await db.query(`UPDATE ${table} SET topic_id = $1 WHERE id = ANY($2) AND topic_id IS NULL`, [topicId, peerIds]);
			} catch (error) {
				logWarn('TOPIC', 'Failed to batch update peer articles', { topicId, error: (error as Error).message });
			}
		}

		const finalTopicId = await attachArticleToTopic(db, table, articleId, topicId);
		if (!finalTopicId) {
			await cleanupTopicIfUnused(db, table, topicId);
			return noResult;
		}

		// Recompute topic stats from actual assigned articles (count + first/last seen timestamps).
		await updateTopicStats(db, finalTopicId);

		const actualArticleCount = await getTopicArticleCount(db, finalTopicId);
		const isNewTopic = finalTopicId === topicId;
		const needsSynthesis = shouldSynthesizeTopic(actualArticleCount, isNewTopic);
		if (!isNewTopic) {
			await cleanupTopicIfUnused(db, table, topicId);
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

async function updateTopicStats(db: Client, topicId: string): Promise<void> {
	try {
		await db.query('SELECT update_topic_stats($1)', [topicId]);
	} catch (error) {
		logWarn('TOPIC', 'Failed to update topic stats', { error: (error as Error).message });
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
export async function synthesizeTopicSummary(db: Client, topicId: string, table: string, apiKey: string): Promise<boolean> {
	logInfo('TOPIC', 'Synthesizing summary for topic', { topicId });

	// Fetch all articles for this topic
	let typedArticles: TopicArticle[];
	try {
		const result = await db.query(
			`SELECT title, title_cn, summary, summary_cn, tags, source FROM ${table} WHERE topic_id = $1 ORDER BY published_date DESC LIMIT 20`,
			[topicId],
		);
		if (result.rows.length === 0) {
			logWarn('TOPIC', 'Failed to fetch articles for topic', { topicId });
			return false;
		}
		typedArticles = result.rows as TopicArticle[];
	} catch (error) {
		logWarn('TOPIC', 'Failed to fetch articles for topic', { topicId, error: (error as Error).message });
		return false;
	}

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
	try {
		await db.query('UPDATE topics SET title = $1, title_cn = $2, description = $3, description_cn = $4, updated_at = $5 WHERE id = $6', [
			result.title,
			result.title_cn,
			result.description,
			result.description_cn,
			new Date().toISOString(),
			topicId,
		]);
	} catch (error) {
		logWarn('TOPIC', 'Failed to update topic', { topicId, error: (error as Error).message });
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
