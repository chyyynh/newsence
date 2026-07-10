import { type ZodType, z } from 'zod';

const CORE_TEXT_MODEL = 'google/gemini-3.1-flash-lite';
const CORE_TEXT_FALLBACK_MODEL = 'google/gemini-2.5-flash-lite';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';
const DEFAULT_AI_GATEWAY_ID = 'default';

type AiBinding = Ai;
type AiMessage = { role: 'system' | 'user'; content: string };
// Generated Worker types strongly type Workers AI catalog models, while AI
// Gateway also accepts third-party `{provider}/{model}` names from docs.
type GatewayAi = { run<Response>(model: string, inputs: object, options?: AiOptions): Promise<Response> };
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

export async function generateText(ai: AiBinding, prompt: string, options: GenerateTextOptions = {}): Promise<string | null> {
	const { gatewayId: gatewayIdValue, systemPrompt, task } = options;
	const inputs = {
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
		generationConfig: {
			...(options.maxTokens != null && { maxOutputTokens: options.maxTokens }),
			temperature: options.temperature ?? 0.3,
		},
	};
	const aiOptions = {
		gateway: {
			id: gatewayIdValue?.trim() || DEFAULT_AI_GATEWAY_ID,
			collectLog: true,
			...(task && { metadata: { app: 'newsence', task } }),
		},
	};

	for (const model of [CORE_TEXT_MODEL, CORE_TEXT_FALLBACK_MODEL]) {
		try {
			const response = await (ai as GatewayAi).run<GeminiTextResponse>(model, inputs, aiOptions);
			const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
			if (text?.trim()) return text.trim();
			throw new Error('No text content found in model response');
		} catch (error) {
			const isFallback = model === CORE_TEXT_FALLBACK_MODEL;
			const log = {
				tag: 'AI',
				msg: isFallback ? 'AI Gateway text generation failed' : 'AI Gateway text generation failed; trying fallback',
				model,
				task,
				error: String(error),
			};
			if (isFallback) console.error(log);
			else console.warn(log);
		}
	}
	return null;
}

export async function generateObject<T>(ai: AiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T | null> {
	const { gatewayId: gatewayIdValue, schema, systemPrompt, task } = options;
	const schemaName = (task ?? 'structured-output').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'structured_output';
	const messages: AiMessage[] = [
		...(systemPrompt ? [{ role: 'system', content: systemPrompt } as const] : []),
		{ role: 'user', content: prompt },
	];

	try {
		const response = await (ai as GatewayAi).run<OpenAIChatResponse>(
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
			{
				gateway: {
					id: gatewayIdValue?.trim() || DEFAULT_AI_GATEWAY_ID,
					collectLog: true,
					...(task && { metadata: { app: 'newsence', task } }),
				},
			},
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
			error: String(error),
		});
		return null;
	}
}
