import { type ZodType, z } from 'zod';
import type { Env } from './types';

export const CORE_TEXT_MODEL = 'google/gemini-3-flash';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';

type AiBinding = Env['AI'];
type AiGatewayMetadata = Record<string, string>;
type AiGatewayOptions = { gateway?: { id: string; collectLog?: boolean; metadata?: AiGatewayMetadata } };
type AiRun = (model: string, inputs: Record<string, unknown>, options?: AiGatewayOptions) => Promise<unknown>;
type AiMessage = { role: 'system' | 'user'; content: string };

export interface AiTask {
	name: string;
	version: string;
}

export const AI_TASKS = {
	articleTranslation: { name: 'article-translation', version: '1' },
	articleContentCleanup: { name: 'article-content-cleanup', version: '1' },
	articleContentTranslation: { name: 'article-content-translation', version: '1' },
	articleClassification: { name: 'article-classification', version: '1' },
	tweetAnalysis: { name: 'tweet-analysis', version: '1' },
	youtubeHighlights: { name: 'youtube-highlights', version: '1' },
	hnEditorialCn: { name: 'hn-editorial-cn', version: '1' },
	hnEditorialEn: { name: 'hn-editorial-en', version: '1' },
} as const satisfies Record<string, AiTask>;

interface GenerateTextOptions {
	gatewayId?: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	task?: AiTask;
}

interface GenerateObjectOptions<T> extends GenerateTextOptions {
	schema: ZodType<T>;
	schemaName?: string;
}

const DEFAULT_AI_GATEWAY_ID = 'default';

function gatewayId(value?: string): string {
	return value?.trim() || DEFAULT_AI_GATEWAY_ID;
}

function taskMetadata(task?: AiTask): Record<string, string> | undefined {
	if (!task) return undefined;
	return { app: 'newsence', task: task.name, taskVersion: task.version };
}

function gatewayOptions(gatewayIdValue?: string, task?: AiTask): AiGatewayOptions {
	return { gateway: { id: gatewayId(gatewayIdValue), collectLog: true, ...(task && { metadata: taskMetadata(task) }) } };
}

function geminiSettings(options: GenerateTextOptions) {
	return {
		...(options.maxTokens != null && { maxOutputTokens: options.maxTokens }),
		temperature: options.temperature ?? 0.3,
	};
}

function openAIChatSettings(options: GenerateTextOptions) {
	return {
		...(options.maxTokens != null && { max_tokens: options.maxTokens }),
		temperature: options.temperature ?? 0.3,
	};
}

function schemaId(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'structured_output';
}

function messages(prompt: string, systemPrompt?: string): AiMessage[] {
	return [...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []), { role: 'user' as const, content: prompt }];
}

function errorDetails(error: unknown): Record<string, unknown> {
	if (!(error instanceof Error)) return { error: String(error) };
	const details: Record<string, unknown> = { error: String(error), name: error.name, message: error.message };
	for (const key of ['statusCode', 'status', 'responseBody', 'data', 'url']) {
		if (key in error) details[key] = (error as unknown as Record<string, unknown>)[key];
	}
	return details;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function partText(content: unknown): string | null {
	if (!isRecord(content) || !Array.isArray(content.parts)) return null;
	const text = content.parts.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
	return text.trim() || null;
}

function choicesText(choices: unknown): string | null {
	if (!Array.isArray(choices)) return null;
	for (const choice of choices) {
		if (!isRecord(choice)) continue;
		const message = choice.message;
		if (isRecord(message) && typeof message.content === 'string') return message.content;
		if (typeof choice.text === 'string') return choice.text;
	}
	return null;
}

function candidatesText(candidates: unknown): string | null {
	if (!Array.isArray(candidates)) return null;
	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		const text = partText(candidate.content);
		if (text) return text;
	}
	return null;
}

function responseText(response: unknown): string | null {
	if (typeof response === 'string') return response;
	if (!isRecord(response)) return null;
	if (typeof response.response === 'string') return response.response;
	if (isRecord(response.response)) return responseText(response.response);
	return (
		(typeof response.text === 'string' && response.text) ||
		(typeof response.output_text === 'string' && response.output_text) ||
		choicesText(response.choices) ||
		candidatesText(response.candidates)
	);
}

function extractJson(text: string): unknown {
	const trimmed = text
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '');
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.search(/[[{]/);
		const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
		if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
		throw new Error('No JSON object found in model response');
	}
}

function structuredPayload(response: unknown): unknown {
	const text = responseText(response);
	if (text) return extractJson(text);
	if (!isRecord(response)) return response;
	if (isRecord(response.response)) return response.response;
	return response;
}

export async function generateText(ai: AiBinding, prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
	const { gatewayId: gatewayIdValue, systemPrompt, task } = options;

	try {
		const response = await (ai.run as AiRun)(
			CORE_TEXT_MODEL,
			{
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
				generationConfig: geminiSettings(options),
			},
			gatewayOptions(gatewayIdValue, task),
		);
		return responseText(response)?.trim() || null;
	} catch (error) {
		console.error({ tag: 'AI', msg: 'AI Gateway text generation failed', model: CORE_TEXT_MODEL, task, ...errorDetails(error) });
		return null;
	}
}

export async function generateObject<T>(ai: AiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T | null> {
	const { gatewayId: gatewayIdValue, schema, schemaName = 'AI structured output', systemPrompt, task } = options;

	try {
		const response = await (ai.run as AiRun)(
			CORE_JSON_MODEL,
			{
				messages: messages(prompt, systemPrompt),
				...openAIChatSettings(options),
				response_format: {
					type: 'json_schema',
					json_schema: {
						name: schemaId(task?.name ?? schemaName),
						schema: z.toJSONSchema(schema),
						strict: true,
					},
				},
			},
			gatewayOptions(gatewayIdValue, task),
		);
		const parsed = schema.safeParse(structuredPayload(response));
		if (!parsed.success) throw parsed.error;
		return parsed.data;
	} catch (error) {
		console.error({
			tag: 'AI',
			msg: 'AI Gateway structured output failed',
			model: CORE_JSON_MODEL,
			schema: schemaName,
			task,
			...errorDetails(error),
		});
		return null;
	}
}
