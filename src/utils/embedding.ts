const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const MAX_TEXT_LENGTH = 8000;

export const EMBEDDING_DIMENSIONS = 1024;

interface AiEmbeddingResult {
	data: number[][];
}

export function prepareArticleTextForEmbedding(article: {
	title: string;
	title_cn?: string | null;
	summary?: string | null;
	summary_cn?: string | null;
	tags?: string[] | null;
	keywords?: string[] | null;
}): string {
	const textParts = [article.title, article.title_cn, article.summary, article.summary_cn];

	if (article.tags?.length) {
		textParts.push(article.tags.join(' '));
	}
	if (article.keywords?.length) {
		textParts.push(article.keywords.join(' '));
	}

	return textParts.filter(Boolean).join(' ').slice(0, MAX_TEXT_LENGTH);
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
			console.error('[Embedding] Invalid response format');
			return null;
		}

		return normalizeVector(result.data[0]);
	} catch (error: unknown) {
		console.error('[Embedding] Workers AI error:', (error as Error).message);
		return null;
	}
}

export async function saveArticleEmbedding(
	supabase: any,
	articleId: string,
	embedding: number[],
	table: string = 'articles'
): Promise<boolean> {
	const vectorStr = `[${embedding.join(',')}]`;

	try {
		// 直接更新指定的表
		const { error } = await supabase
			.from(table)
			.update({ embedding: vectorStr })
			.eq('id', articleId);

		if (error) {
			console.error(`[Embedding] Failed to save for ${articleId} in ${table}:`, error.message);
			return false;
		}

		console.log(`[Embedding] Saved to ${table} for ${articleId}`);
		return true;
	} catch (error: unknown) {
		console.error(`[Embedding] Error saving for ${articleId}:`, (error as Error).message);
		return false;
	}
}
