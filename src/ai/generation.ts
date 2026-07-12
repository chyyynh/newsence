import { type ZodType, z } from 'zod';

const CORE_TEXT_MODEL = 'google/gemini-3.5-flash';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';
const DEFAULT_AI_GATEWAY_ID = 'default';

type GenerationAiBinding = Ai;
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

export async function generateText(ai: GenerationAiBinding, prompt: string, options: GenerateTextOptions = {}): Promise<string> {
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

	const response = await (ai as GatewayAi).run<GeminiTextResponse>(CORE_TEXT_MODEL, inputs, aiOptions);
	const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
	if (!text?.trim()) throw new Error(`AI Gateway returned no text for ${task ?? 'text-generation'}`);
	return text.trim();
}

export async function generateObject<T>(ai: GenerationAiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T> {
	const { gatewayId: gatewayIdValue, schema, systemPrompt, task } = options;
	const schemaName = (task ?? 'structured-output').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'structured_output';
	const messages: AiMessage[] = [
		...(systemPrompt ? [{ role: 'system', content: systemPrompt } as const] : []),
		{ role: 'user', content: prompt },
	];

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
	const text = response.choices?.[0]?.message?.content?.trim();
	if (!text) throw new Error(`AI Gateway returned no structured output for ${task ?? 'structured-output'}`);
	return schema.parse(JSON.parse(text));
}
