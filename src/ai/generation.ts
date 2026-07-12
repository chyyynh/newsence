import { type ZodType, z } from 'zod';

const CORE_TEXT_MODEL = 'google/gemini-3.5-flash';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';

type GenerationAiBinding = Ai;
type AiMessage = { role: 'system' | 'user'; content: string };
// Generated Worker types strongly type Workers AI catalog models, while AI
// Gateway also accepts third-party `{provider}/{model}` names from docs.
type GatewayAi = { run<Response>(model: string, inputs: object, options?: AiOptions): Promise<Response> };
type GeminiTextResponse = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
type OpenAIChatResponse = { choices?: Array<{ message?: { content?: string } }> };

interface GenerateTextOptions {
	gatewayId: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	task: string;
}

interface GenerateObjectOptions<T> extends GenerateTextOptions {
	schema: ZodType<T>;
}

export async function generateText(ai: GenerationAiBinding, prompt: string, options: GenerateTextOptions): Promise<string> {
	const { systemPrompt, task } = options;
	const gatewayId = options.gatewayId.trim();
	if (!gatewayId) throw new Error('AI Gateway id is required');
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
			id: gatewayId,
			collectLog: true,
			metadata: { app: 'newsence', task },
		},
	};

	const response = await (ai as GatewayAi).run<GeminiTextResponse>(CORE_TEXT_MODEL, inputs, aiOptions);
	const parts = response.candidates?.[0]?.content?.parts;
	if (!parts?.length) throw new Error(`AI Gateway returned no parts for ${task}`);
	const text = parts
		.map((part, index) => {
			if (typeof part.text !== 'string') throw new Error(`AI Gateway returned non-text part ${index} for ${task}`);
			return part.text;
		})
		.join('')
		.trim();
	if (!text) throw new Error(`AI Gateway returned no text for ${task}`);
	return text;
}

export async function generateObject<T>(ai: GenerationAiBinding, prompt: string, options: GenerateObjectOptions<T>): Promise<T> {
	const { schema, systemPrompt, task } = options;
	const gatewayId = options.gatewayId.trim();
	if (!gatewayId) throw new Error('AI Gateway id is required');
	const schemaName = task.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
	if (!schemaName) throw new Error(`AI task ${task} has no valid schema name`);
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
				id: gatewayId,
				collectLog: true,
				metadata: { app: 'newsence', task },
			},
		},
	);
	const text = response.choices?.[0]?.message?.content?.trim();
	if (!text) throw new Error(`AI Gateway returned no structured output for ${task}`);
	return schema.parse(JSON.parse(text));
}
