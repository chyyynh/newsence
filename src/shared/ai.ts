import { type ZodType, z } from 'zod';
import type { Env } from './types';

export const CORE_TEXT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

type AiBinding = Env['AI'];
type AiTextModel = typeof CORE_TEXT_MODEL;
type JsonSchema = Record<string, unknown>;

export interface AiTask {
	name: string;
	version: string;
}

export const AI_TASKS = {
	articleTranslation: { name: 'article-translation', version: '1' },
	articleClassification: { name: 'article-classification', version: '1' },
	tweetAnalysis: { name: 'tweet-analysis', version: '1' },
	youtubeHighlights: { name: 'youtube-highlights', version: '1' },
	hnEditorialCn: { name: 'hn-editorial-cn', version: '1' },
	hnEditorialEn: { name: 'hn-editorial-en', version: '1' },
} as const satisfies Record<string, AiTask>;

interface GenerateTextOptions {
	model?: AiTextModel;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	task?: AiTask;
}

interface GenerateJsonOptions extends GenerateTextOptions {
	schema: JsonSchema;
}

interface GenerateObjectOptions<T> extends GenerateTextOptions {
	schema: ZodType<T>;
	schemaName?: string;
	maxAttempts?: number;
}

const DEFAULT_STRUCTURED_ATTEMPTS = 2;
const STRUCTURED_RETRY_SUFFIX = `再次確認：只輸出符合 JSON Schema 的 JSON 物件。不要 Markdown、不要解釋、不要包在 code fence。`;

function buildMessages(prompt: string, systemPrompt?: string): Array<{ role: 'system' | 'user'; content: string }> {
	return systemPrompt
		? [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: prompt },
			]
		: [{ role: 'user', content: prompt }];
}

function buildTextGenerationInput(
	options: GenerateTextOptions,
	prompt: string,
	responseFormat?: { type: 'json_schema'; json_schema: JsonSchema },
) {
	const { maxTokens, temperature = 0.3, systemPrompt } = options;
	return {
		messages: buildMessages(prompt, systemPrompt),
		...(maxTokens != null && { max_tokens: maxTokens }),
		temperature,
		...(responseFormat && { response_format: responseFormat }),
	};
}

function sanitizeAiTag(value: string): string {
	return value.replace(/[^A-Za-z0-9:./@-]/g, '-').slice(0, 50);
}

function buildRunOptions(task?: AiTask): { tags: string[] } | undefined {
	if (!task) return undefined;
	return { tags: ['newsence', sanitizeAiTag(`task:${task.name}`), sanitizeAiTag(`version:${task.version}`)] };
}

function extractResponse(result: unknown): unknown {
	if (!result || typeof result !== 'object') return result;
	return 'response' in result ? result.response : result;
}

function parseJsonResponse<T>(result: unknown): T | null {
	const response = extractResponse(result);
	if (response && typeof response === 'object') return response as T;
	if (typeof response !== 'string') return null;

	try {
		return JSON.parse(response) as T;
	} catch {
		const match = response.match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]) as T;
		} catch {
			return null;
		}
	}
}

export async function generateText(ai: AiBinding, prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
	const { model = CORE_TEXT_MODEL, task } = options;

	try {
		const result = await ai.run(model, buildTextGenerationInput(options, prompt), buildRunOptions(task));
		const response = extractResponse(result);
		return typeof response === 'string' && response.trim() ? response : null;
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Workers AI text generation failed', model, task, error: String(error) });
		return null;
	}
}

export async function generateJson<T>(ai: AiBinding, prompt: string, options: GenerateJsonOptions): Promise<T | null> {
	const { model = CORE_TEXT_MODEL, task, schema } = options;

	try {
		const result = await ai.run(
			model,
			buildTextGenerationInput(options, prompt, {
				type: 'json_schema',
				json_schema: schema,
			}),
			buildRunOptions(task),
		);
		return parseJsonResponse<T>(result);
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Workers AI JSON generation failed', model, task, error: String(error) });
		return null;
	}
}

export async function generateObject<T>(ai: AiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T | null> {
	const { schema, schemaName = 'AI structured output', maxAttempts = DEFAULT_STRUCTURED_ATTEMPTS, ...generationOptions } = options;
	const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7' }) as JsonSchema;
	const attempts = Math.max(1, Math.trunc(maxAttempts));
	let lastError = 'unknown validation error';

	for (let attempt = 1; attempt <= attempts; attempt++) {
		const attemptPrompt = attempt === 1 ? prompt : `${prompt}\n\n${STRUCTURED_RETRY_SUFFIX}`;
		const result = await generateJson<unknown>(ai, attemptPrompt, { ...generationOptions, schema: jsonSchema });
		const parsed = schema.safeParse(result);
		if (parsed.success) return parsed.data;

		lastError = z.prettifyError(parsed.error);
		if (attempt < attempts) {
			console.warn({
				tag: 'AI',
				msg: 'Workers AI structured output validation failed; retrying',
				schema: schemaName,
				task: generationOptions.task,
				attempt,
				error: lastError,
			});
		}
	}

	console.error({
		tag: 'AI',
		msg: 'Workers AI structured output validation failed',
		schema: schemaName,
		task: generationOptions.task,
		attempts,
		error: lastError,
	});
	return null;
}
