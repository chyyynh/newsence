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
			console.error({ tag: 'EMBEDDING', msg: 'Invalid response format' });
			return null;
		}

		// bge-m3 output is stored/queried with pgvector cosine (`<=>`,
		// vector_cosine_ops), which is scale-invariant — no L2 normalization needed.
		return result.data[0];
	} catch (error: unknown) {
		console.error({ tag: 'EMBEDDING', msg: 'Workers AI error', error: (error as Error).message });
		return null;
	}
}
