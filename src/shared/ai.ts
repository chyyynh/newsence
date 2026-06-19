import type { Env } from './types';

export const CORE_TEXT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

type AiBinding = Env['AI'];
type AiTextModel = typeof CORE_TEXT_MODEL;
type JsonSchema = Record<string, unknown>;

interface GenerateTextOptions {
	model?: AiTextModel;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
}

interface GenerateJsonOptions extends GenerateTextOptions {
	schema: JsonSchema;
}

function buildMessages(prompt: string, systemPrompt?: string): Array<{ role: 'system' | 'user'; content: string }> {
	return systemPrompt
		? [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: prompt },
			]
		: [{ role: 'user', content: prompt }];
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
	const { model = CORE_TEXT_MODEL, maxTokens, temperature = 0.3, systemPrompt } = options;

	try {
		const result = await ai.run(model, {
			messages: buildMessages(prompt, systemPrompt),
			...(maxTokens != null && { max_tokens: maxTokens }),
			temperature,
		});
		const response = extractResponse(result);
		return typeof response === 'string' && response.trim() ? response : null;
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Workers AI text generation failed', model, error: String(error) });
		return null;
	}
}

export async function generateJson<T>(ai: AiBinding, prompt: string, options: GenerateJsonOptions): Promise<T | null> {
	const { model = CORE_TEXT_MODEL, maxTokens, temperature = 0.3, systemPrompt, schema } = options;

	try {
		const result = await ai.run(model, {
			messages: buildMessages(prompt, systemPrompt),
			...(maxTokens != null && { max_tokens: maxTokens }),
			temperature,
			response_format: {
				type: 'json_schema',
				json_schema: schema,
			},
		});
		return parseJsonResponse<T>(result);
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Workers AI JSON generation failed', model, error: String(error) });
		return null;
	}
}
