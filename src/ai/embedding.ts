import type { Article } from '@core-shared/types';
import { type ZodType, z } from 'zod';

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const CORE_TEXT_MODEL = 'google/gemini-3-flash';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';
const MAX_TEXT_LENGTH = 8000;
const DEFAULT_AI_GATEWAY_ID = 'default';

type AiBinding = Ai;
type AiMessage = { role: 'system' | 'user'; content: string };
type GatewayRun = <Response>(model: string, inputs: object, options?: AiOptions) => Promise<Response>;
type GeminiTextResponse = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
type OpenAIChatResponse = { choices?: Array<{ message?: { content?: string } }> };

interface GenerateTextOptions {
	gatewayId?: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	task?: string;
}

interface GenerateObjectOptions<T> extends GenerateTextOptions {
	schema: ZodType<T>;
}

function gatewayOptions(gatewayName?: string, task?: string): AiOptions {
	return {
		gateway: {
			id: gatewayName?.trim() || DEFAULT_AI_GATEWAY_ID,
			collectLog: true,
			...(task && { metadata: { app: 'newsence', task } }),
		},
	};
}

function runGatewayModel<Response>(ai: AiBinding, model: string, inputs: object, options?: AiOptions): Promise<Response> {
	// Generated Worker types strongly type Workers AI catalog models, while AI
	// Gateway also accepts third-party `{provider}/{model}` names from docs.
	return (ai.run as unknown as GatewayRun)<Response>(model, inputs, options);
}

function errorDetails(error: unknown): Record<string, unknown> {
	if (!(error instanceof Error)) return { error: String(error) };
	const details: Record<string, unknown> = { error: String(error), name: error.name, message: error.message };
	for (const key of ['statusCode', 'status', 'responseBody', 'data', 'url']) {
		if (key in error) details[key] = (error as unknown as Record<string, unknown>)[key];
	}
	return details;
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

export async function generateText(ai: AiBinding, prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
	const { gatewayId: gatewayIdValue, systemPrompt, task } = options;

	try {
		const response = await runGatewayModel<GeminiTextResponse>(
			ai,
			CORE_TEXT_MODEL,
			{
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
				generationConfig: {
					...(options.maxTokens != null && { maxOutputTokens: options.maxTokens }),
					temperature: options.temperature ?? 0.3,
				},
			},
			gatewayOptions(gatewayIdValue, task),
		);
		const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
		return text?.trim() || null;
	} catch (error) {
		console.error({ tag: 'AI', msg: 'AI Gateway text generation failed', model: CORE_TEXT_MODEL, task, ...errorDetails(error) });
		return null;
	}
}

export async function generateObject<T>(ai: AiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T | null> {
	const { gatewayId: gatewayIdValue, schema, systemPrompt, task } = options;
	const schemaName = (task ?? 'structured-output').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'structured_output';
	const messages: AiMessage[] = [
		...(systemPrompt ? [{ role: 'system', content: systemPrompt } as const] : []),
		{ role: 'user', content: prompt },
	];

	try {
		const response = await runGatewayModel<OpenAIChatResponse>(
			ai,
			CORE_JSON_MODEL,
			{
				messages,
				...(options.maxTokens != null && { max_tokens: options.maxTokens }),
				temperature: options.temperature ?? 0.3,
				response_format: {
					type: 'json_schema',
					json_schema: {
						name: schemaName,
						schema: z.toJSONSchema(schema),
						strict: true,
					},
				},
			},
			gatewayOptions(gatewayIdValue, task),
		);
		const text = response.choices?.[0]?.message?.content?.trim() || null;
		if (!text) throw new Error('No text content found in model response');

		const parsed = schema.safeParse(JSON.parse(text));
		if (!parsed.success) throw parsed.error;
		return parsed.data;
	} catch (error) {
		console.error({
			tag: 'AI',
			msg: 'AI Gateway structured output failed',
			model: CORE_JSON_MODEL,
			schema: task,
			task,
			...errorDetails(error),
		});
		return null;
	}
}

export async function generateArticleEmbedding(text: string, ai: Ai, gatewayName?: string): Promise<number[] | null> {
	const sanitizedText = text?.trim();
	if (!sanitizedText) return null;

	try {
		const result = await ai.run(
			EMBEDDING_MODEL,
			{ text: [sanitizedText.slice(0, MAX_TEXT_LENGTH)] },
			gatewayOptions(gatewayName, 'article-embedding'),
		);
		const record = typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
		const first = Array.isArray(record?.data) ? record.data[0] : null;
		const embedding = Array.isArray(first) && first.every((value) => typeof value === 'number') ? first : null;

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
