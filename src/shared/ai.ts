import { generateText as aiGenerateText, Output } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { openai } from 'workers-ai-provider/openai';
import type { ZodType } from 'zod';
import type { Env } from './types';

export const CORE_TEXT_MODEL = 'google/gemini-3-flash';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';

type AiBinding = Env['AI'];
type AiGatewayMetadata = Record<string, string>;

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

export function createCoreAI(ai: AiBinding, gatewayIdValue?: string, metadata?: AiGatewayMetadata) {
	return createWorkersAI({
		binding: ai,
		gateway: { id: gatewayId(gatewayIdValue), collectLog: true, ...(metadata && { metadata }) },
		providers: [openai],
	});
}

function taskMetadata(task?: AiTask): Record<string, string> | undefined {
	if (!task) return undefined;
	return { app: 'newsence', task: task.name, taskVersion: task.version };
}

function generationSettings(options: GenerateTextOptions) {
	return {
		...(options.maxTokens != null && { maxOutputTokens: options.maxTokens }),
		temperature: options.temperature ?? 0.3,
	};
}

export async function generateText(ai: AiBinding, prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
	const { gatewayId: gatewayIdValue, systemPrompt, task } = options;

	try {
		const workersai = createCoreAI(ai, gatewayIdValue, taskMetadata(task));
		const result = await aiGenerateText({
			model: workersai(CORE_TEXT_MODEL),
			prompt,
			...(systemPrompt && { system: systemPrompt }),
			...generationSettings(options),
		});
		return result.text.trim() || null;
	} catch (error) {
		console.error({ tag: 'AI', msg: 'AI Gateway text generation failed', model: CORE_TEXT_MODEL, task, error: String(error) });
		return null;
	}
}

export async function generateObject<T>(ai: AiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T | null> {
	const { gatewayId: gatewayIdValue, schema, schemaName = 'AI structured output', systemPrompt, task } = options;

	try {
		const workersai = createCoreAI(ai, gatewayIdValue, taskMetadata(task));
		const result = await aiGenerateText({
			model: workersai(CORE_JSON_MODEL),
			prompt,
			...(systemPrompt && { system: systemPrompt }),
			output: Output.object({ schema, name: schemaName }),
			...generationSettings(options),
		});
		return result.output;
	} catch (error) {
		console.error({
			tag: 'AI',
			msg: 'AI Gateway structured output failed',
			model: CORE_JSON_MODEL,
			schema: schemaName,
			task,
			error: String(error),
		});
		return null;
	}
}
