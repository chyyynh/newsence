import { type ZodType, z } from 'zod';
import type { Env } from './types';

export const CORE_TEXT_MODEL = 'google/gemini-3-flash';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';

type AiBinding = Env['AI'];
type AiRun = (model: string, inputs: Record<string, unknown>, options?: AiOptions) => Promise<unknown>;
type AiMessage = { role: 'system' | 'user'; content: string };
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

const DEFAULT_AI_GATEWAY_ID = 'default';

function gatewayId(value?: string): string {
	return value?.trim() || DEFAULT_AI_GATEWAY_ID;
}

function gatewayOptions(gatewayIdValue?: string, task?: string): AiOptions {
	return {
		gateway: {
			id: gatewayId(gatewayIdValue),
			collectLog: true,
			...(task && { metadata: { app: 'newsence', task } }),
		},
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

function geminiText(response: GeminiTextResponse): string | null {
	const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
	return text?.trim() || null;
}

function openAIText(response: OpenAIChatResponse): string | null {
	return response.choices?.[0]?.message?.content?.trim() || null;
}

export async function generateText(ai: AiBinding, prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
	const { gatewayId: gatewayIdValue, systemPrompt, task } = options;

	try {
		const response = (await (ai.run as AiRun)(
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
		)) as GeminiTextResponse;
		return geminiText(response);
	} catch (error) {
		console.error({ tag: 'AI', msg: 'AI Gateway text generation failed', model: CORE_TEXT_MODEL, task, ...errorDetails(error) });
		return null;
	}
}

export async function generateObject<T>(ai: AiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T | null> {
	const { gatewayId: gatewayIdValue, schema, systemPrompt, task } = options;

	try {
		const response = (await (ai.run as AiRun)(
			CORE_JSON_MODEL,
			{
				messages: messages(prompt, systemPrompt),
				...(options.maxTokens != null && { max_tokens: options.maxTokens }),
				temperature: options.temperature ?? 0.3,
				response_format: {
					type: 'json_schema',
					json_schema: {
						name: schemaId(task ?? 'structured-output'),
						schema: z.toJSONSchema(schema),
						strict: true,
					},
				},
			},
			gatewayOptions(gatewayIdValue, task),
		)) as OpenAIChatResponse;
		const text = openAIText(response);
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
