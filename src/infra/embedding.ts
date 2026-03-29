import { logError, logInfo } from './log';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const MAX_TEXT_LENGTH = 8000;

interface AiEmbeddingResult {
	data: number[][];
}

export function prepareArticleTextForEmbedding(article: {
	title: string;
	title_cn?: string | null;
	summary?: string | null;
	summary_cn?: string | null;
	content?: string | null;
	content_cn?: string | null;
	tags?: string[] | null;
	keywords?: string[] | null;
}): string {
	// Priority: title + summary (high signal density), then metadata, then content (fills remaining budget)
	const priorityParts = [article.title, article.title_cn, article.summary, article.summary_cn].filter(Boolean) as string[];

	const metaParts: string[] = [];
	if (article.tags?.length) metaParts.push(article.tags.join(' '));
	if (article.keywords?.length) metaParts.push(article.keywords.join(' '));

	const headerText = [...priorityParts, ...metaParts].join(' ');
	const contentBudget = MAX_TEXT_LENGTH - headerText.length - 1;

	if (contentBudget <= 200) return headerText.slice(0, MAX_TEXT_LENGTH);

	const contentParts: string[] = [];
	if (article.content && article.content_cn) {
		const half = Math.floor(contentBudget / 2);
		contentParts.push(article.content.slice(0, half));
		contentParts.push(article.content_cn.slice(0, half));
	} else {
		const src = article.content || article.content_cn;
		if (src) contentParts.push(src.slice(0, contentBudget));
	}

	return [headerText, ...contentParts].join(' ').slice(0, MAX_TEXT_LENGTH);
}

export function normalizeVector(values: number[]): number[] {
	const norm = Math.sqrt(values.reduce((sum, val) => sum + val * val, 0));
	return norm === 0 ? values : values.map((v) => v / norm);
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

		return normalizeVector(result.data[0]);
	} catch (error: unknown) {
		logError('EMBEDDING', 'Workers AI error', { error: (error as Error).message });
		return null;
	}
}

export async function saveArticleEmbedding(
	db: import('pg').Client,
	articleId: string,
	embedding: number[],
	table: string = 'articles',
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
