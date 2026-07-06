import type { Article } from '@core-shared/types';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_AI_GATEWAY_ID = 'default';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstEmbedding(response: unknown): number[] | null {
	if (!isRecord(response) || !Array.isArray(response.data) || !Array.isArray(response.data[0])) return null;
	return response.data[0].every((value) => typeof value === 'number') ? response.data[0] : null;
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

export async function generateArticleEmbedding(text: string, ai: Ai, gatewayName?: string): Promise<number[] | null> {
	const sanitizedText = text?.trim();
	if (!sanitizedText) return null;

	try {
		const result = await ai.run(
			EMBEDDING_MODEL,
			{ text: [sanitizedText.slice(0, MAX_TEXT_LENGTH)] },
			{
				gateway: {
					id: gatewayName?.trim() || DEFAULT_AI_GATEWAY_ID,
					collectLog: true,
					metadata: { app: 'newsence', task: 'article-embedding' },
				},
			},
		);
		const embedding = firstEmbedding(result);

		if (!embedding?.length) {
			console.error({ tag: 'EMBEDDING', msg: 'Invalid response format' });
			return null;
		}

		// bge-m3 output is stored/queried with pgvector cosine (`<=>`,
		// vector_cosine_ops), which is scale-invariant — no L2 normalization needed.
		return embedding;
	} catch (error: unknown) {
		console.error({ tag: 'EMBEDDING', msg: 'Workers AI error', error: (error as Error).message });
		return null;
	}
}
