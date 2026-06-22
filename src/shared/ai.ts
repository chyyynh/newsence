import { type ZodType, z } from 'zod';
import type { Env } from './types';

export const CORE_TEXT_MODEL = 'google/gemini-3-flash';

type AiBinding = Env['AI'];
type AiTextModel = string;
type JsonSchema = Record<string, unknown>;
interface AiGatewayRunOptions {
	gateway: { id: string };
	tags?: string[];
}
interface AiGatewayTextBinding {
	run(model: string, input: Record<string, unknown>, options: AiGatewayRunOptions): Promise<unknown>;
}

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
	gatewayId?: string;
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
}

const DEFAULT_AI_GATEWAY_ID = 'default';
const GEMINI_JSON_SCHEMA_KEYS = new Set([
	'$anchor',
	'$defs',
	'$id',
	'$ref',
	'additionalProperties',
	'anyOf',
	'description',
	'enum',
	'format',
	'items',
	'maxItems',
	'maximum',
	'minItems',
	'minimum',
	'oneOf',
	'prefixItems',
	'properties',
	'propertyOrdering',
	'required',
	'title',
	'type',
]);

function buildGeminiContent(text: string): { role: 'user'; parts: Array<{ text: string }> } {
	return { role: 'user', parts: [{ text }] };
}

function buildTextGenerationInput(options: GenerateTextOptions, prompt: string, responseSchema?: JsonSchema): Record<string, unknown> {
	const { maxTokens, temperature = 0.3, systemPrompt } = options;
	const generationConfig: Record<string, unknown> = {
		temperature,
		thinkingConfig: { thinkingBudget: 0 },
		...(maxTokens != null && { maxOutputTokens: maxTokens }),
		...(responseSchema && {
			responseMimeType: 'application/json',
			responseSchema,
		}),
	};

	return {
		contents: [buildGeminiContent(prompt)],
		generationConfig,
		...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
	};
}

function sanitizeAiTag(value: string): string {
	return value.replace(/[^A-Za-z0-9:./@-]/g, '-').slice(0, 50);
}

function buildRunOptions(task?: AiTask, gatewayId?: string): AiGatewayRunOptions {
	return {
		gateway: { id: gatewayId?.trim() || DEFAULT_AI_GATEWAY_ID },
		...(task && { tags: ['newsence', sanitizeAiTag(`task:${task.name}`), sanitizeAiTag(`version:${task.version}`)] }),
	};
}

function runGatewayModel(
	ai: AiBinding,
	model: AiTextModel,
	input: Record<string, unknown>,
	options: AiGatewayRunOptions,
): Promise<unknown> {
	return (ai as AiGatewayTextBinding).run(model, input, options);
}

function extractResponse(result: unknown): unknown {
	if (!result || typeof result !== 'object') return result;
	return 'response' in result ? result.response : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractGeminiText(result: unknown): string | null {
	const response = extractResponse(result);
	if (typeof response === 'string') return response.trim() ? response : null;
	if (!isRecord(response)) return null;

	const [candidate] = Array.isArray(response.candidates) ? response.candidates : [];
	if (isRecord(candidate) && isRecord(candidate.content) && Array.isArray(candidate.content.parts)) {
		const text = candidate.content.parts
			.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
			.join('')
			.trim();
		return text || null;
	}

	const [choice] = Array.isArray(response.choices) ? response.choices : [];
	if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string') return null;
	const text = choice.message.content.trim();
	return text || null;
}

function parseJsonResponse<T>(result: unknown): T | null {
	const response = extractResponse(result);
	if (isRecord(response) && !('candidates' in response) && !('choices' in response)) return response as T;

	const text = extractGeminiText(result);
	if (!text) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function buildGeminiJsonSchema(schema: ZodType): JsonSchema {
	return sanitizeGeminiJsonSchema(z.toJSONSchema(schema, { target: 'draft-7' }));
}

function sanitizeGeminiJsonSchema(value: unknown, parentKey?: string): JsonSchema {
	if (!isRecord(value)) return {};

	return Object.fromEntries(
		Object.entries(value).flatMap(([key, childValue]) => {
			if (parentKey !== 'properties' && parentKey !== '$defs' && !GEMINI_JSON_SCHEMA_KEYS.has(key)) return [];
			if (isRecord(childValue)) return [[key, sanitizeGeminiJsonSchema(childValue, key)]];
			if (Array.isArray(childValue)) {
				return [[key, childValue.map((item) => (isRecord(item) ? sanitizeGeminiJsonSchema(item, key) : item))]];
			}
			return [[key, childValue]];
		}),
	);
}

export async function generateText(ai: AiBinding, prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
	const { model = CORE_TEXT_MODEL, task, gatewayId } = options;

	try {
		const result = await runGatewayModel(ai, model, buildTextGenerationInput(options, prompt), buildRunOptions(task, gatewayId));
		return extractGeminiText(result);
	} catch (error) {
		console.error({ tag: 'AI', msg: 'AI Gateway text generation failed', model, task, error: String(error) });
		return null;
	}
}

export async function generateJson<T>(ai: AiBinding, prompt: string, options: GenerateJsonOptions): Promise<T | null> {
	const { model = CORE_TEXT_MODEL, task, schema, gatewayId } = options;

	try {
		const result = await runGatewayModel(ai, model, buildTextGenerationInput(options, prompt, schema), buildRunOptions(task, gatewayId));
		return parseJsonResponse<T>(result);
	} catch (error) {
		console.error({ tag: 'AI', msg: 'AI Gateway JSON generation failed', model, task, error: String(error) });
		return null;
	}
}

export async function generateObject<T>(ai: AiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T | null> {
	const { schema, schemaName = 'AI structured output', ...generationOptions } = options;
	const jsonSchema = buildGeminiJsonSchema(schema);
	const result = await generateJson<unknown>(ai, prompt, { ...generationOptions, schema: jsonSchema });
	const parsed = schema.safeParse(result);
	if (parsed.success) return parsed.data;

	console.error({
		tag: 'AI',
		msg: 'AI Gateway structured output validation failed',
		schema: schemaName,
		task: generationOptions.task,
		error: z.prettifyError(parsed.error),
	});
	return null;
}
