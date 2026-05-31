import { ARTICLES_TABLE, type ProcessableTable } from './db/articles';
import { logError, logInfo } from './log';
import type { Article } from './types';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const MAX_TEXT_LENGTH = 8000;

interface AiEmbeddingResult {
	data: number[][];
}

// Original language only — BGE-M3 is cross-lingual, so embedding `_cn`
// translations dilutes the budget without adding recall.
type EmbeddingInput = Pick<Article, 'title' | 'summary' | 'content' | 'tags' | 'keywords'>;

export function prepareArticleTextForEmbedding(article: EmbeddingInput): string {
	const headerParts = [article.title];
	if (article.summary) headerParts.push(article.summary);
	if (article.tags.length) headerParts.push(article.tags.join(' '));
	if (article.keywords.length) headerParts.push(article.keywords.join(' '));

	const headerText = headerParts.join(' ');
	const contentBudget = MAX_TEXT_LENGTH - headerText.length - 1;

	if (contentBudget <= 200 || !article.content) {
		return headerText.slice(0, MAX_TEXT_LENGTH);
	}

	return `${headerText} ${article.content.slice(0, contentBudget)}`.slice(0, MAX_TEXT_LENGTH);
}

export async function generateArticleEmbedding(text: string, ai: Ai): Promise<number[] | null> {
	const sanitizedText = text?.trim();
	if (!sanitizedText) return null;

	try {
		const result = (await ai.run(EMBEDDING_MODEL as Parameters<Ai['run']>[0], {
			text: [sanitizedText.slice(0, MAX_TEXT_LENGTH)],
		})) as AiEmbeddingResult;

		if (!result.data?.[0]) {
			logError('EMBEDDING', 'Invalid response format');
			return null;
		}

		// bge-m3 output is stored/queried with pgvector cosine (`<=>`,
		// vector_cosine_ops), which is scale-invariant — no L2 normalization needed.
		return result.data[0];
	} catch (error: unknown) {
		logError('EMBEDDING', 'Workers AI error', { error: (error as Error).message });
		return null;
	}
}

export async function saveArticleEmbedding(
	db: import('pg').Client,
	articleId: string,
	embedding: number[],
	table: ProcessableTable = ARTICLES_TABLE,
): Promise<boolean> {
	const vectorStr = `[${embedding.join(',')}]`;

	try {
		await db.query(`UPDATE ${table} SET embedding = $1 WHERE id = $2`, [vectorStr, articleId]);
		logInfo('EMBEDDING', 'Saved', { articleId, table });
		return true;
	} catch (error: unknown) {
		logError('EMBEDDING', 'Error saving', { articleId, error: (error as Error).message });
		return false;
	}
}
