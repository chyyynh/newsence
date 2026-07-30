import { type ZodType, z } from 'zod';

// Prose generation runs on Workers AI, not the third-party catalog: it bills to
// Workers AI instead of the prepaid Gateway credits (so translation volume can
// no longer starve ingest) and costs ~28x less per output token. Note that it
// does think, and the thinking bills as output tokens; the reasoning arrives in
// message.reasoning, so only the cost is affected, never the returned text.
const CORE_TEXT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';

type GenerationAiBinding = Ai;
type AiMessage = { role: 'system' | 'user'; content: string };
// Generated Worker types strongly type Workers AI catalog models, while AI
// Gateway also accepts third-party `{provider}/{model}` names from docs.
type GatewayAi = { run<Response>(model: string, inputs: object, options?: AiOptions): Promise<Response> };
type WorkersAiChatResponse = {
	response?: string;
	choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
};
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
	const messages: AiMessage[] = [
		...(systemPrompt ? [{ role: 'system', content: systemPrompt } as const] : []),
		{ role: 'user', content: prompt },
	];
	const inputs = {
		messages,
		...(options.maxTokens != null && { max_tokens: options.maxTokens }),
		temperature: options.temperature ?? 0.3,
	};
	const aiOptions = {
		gateway: {
			id: gatewayId,
			collectLog: true,
			metadata: { app: 'newsence', task },
		},
	};

	const response = await (ai as GatewayAi).run<WorkersAiChatResponse>(CORE_TEXT_MODEL, inputs, aiOptions);
	const choice = response.choices?.[0];
	// Hitting the cap used to be invisible: the cut-off text was joined into the
	// final translation and persisted as if complete, and the <20% partial-refresh
	// guard never fires for an article that merely lost its last chunk. Throwing
	// retries the step, and an exhausted retry leaves the row untranslated rather
	// than silently half-translated.
	if (choice?.finish_reason === 'length') {
		throw new Error(`AI output hit the ${options.maxTokens ?? 'default'} token cap for ${task}; refusing to persist a truncated result`);
	}
	const text = (choice?.message?.content ?? response.response ?? '').trim();
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
