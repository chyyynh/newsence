import { type ZodType, z } from 'zod';

// System-ingest prose uses Workers AI inside the dedicated core gateway, keeping
// its cost analytics and protection separate from end-user product inference.
// The model's internal reasoning bills as output tokens but is not returned as
// generated prose.
const CORE_TEXT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const CORE_JSON_MODEL = 'openai/gpt-4.1-mini';
const CORE_AI_GATEWAY_ID = 'core-ingest';

type AiMessage = { role: 'system' | 'user'; content: string };
type CoreAiModel = typeof CORE_TEXT_MODEL | typeof CORE_JSON_MODEL;
type WorkersAiRunner = { run<Result>(model: string, inputs: object, options?: AiOptions): Promise<Result> };
type WorkersAiChatResponse = {
	response?: string;
	choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
};

interface GenerateTextOptions {
	feature: string;
	maxTokens?: number;
	resourceId?: string;
	temperature?: number;
	systemPrompt?: string;
}

interface GenerateObjectOptions<T> extends GenerateTextOptions {
	schema: ZodType<T>;
}

type CoreAiRequestContext = Pick<GenerateTextOptions, 'feature' | 'resourceId'>;
type CoreAiErrorContext = CoreAiRequestContext & { bindingGatewayLogId?: string | null; model: string };

function headerValue(headers: unknown, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (typeof headers !== 'object' || headers === null) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name && typeof value === 'string') return value;
	}
	return undefined;
}

type RateLimitDetails = { gatewayLogId?: string; retryAfter?: string };

function nestedErrors(error: Record<string, unknown>): unknown[] {
	const nested = [error.cause, error.lastError].filter((value) => value !== undefined);
	if (Array.isArray(error.errors)) nested.push(...error.errors);
	if (Array.isArray(error.attempts)) {
		for (const attempt of error.attempts) {
			if (typeof attempt === 'object' && attempt !== null && 'error' in attempt) nested.push(attempt.error);
		}
	}
	return nested;
}

// A raw 429 has several possible upstream meanings. Classify only documented
// transport fields and structured wrapper causes, never provider message text.
function rateLimitDetails(error: unknown, seen = new Set<unknown>()): RateLimitDetails | null {
	if (typeof error !== 'object' || error === null || seen.has(error)) return null;
	seen.add(error);

	const record = error as Record<string, unknown>;
	const response = record.response instanceof Response ? record.response : null;
	const status = error instanceof Response ? error.status : (record.status ?? record.statusCode ?? response?.status);
	const headers = error instanceof Response ? error.headers : (record.responseHeaders ?? record.headers ?? response?.headers);
	const nested = nestedErrors(record);
	const nestedDetails = nested.reduce<RateLimitDetails | null>((details, item) => {
		const itemDetails = rateLimitDetails(item, seen);
		if (!itemDetails) return details;
		return {
			gatewayLogId: details?.gatewayLogId ?? itemDetails.gatewayLogId,
			retryAfter: details?.retryAfter ?? itemDetails.retryAfter,
		};
	}, null);
	if (status === 429) {
		return {
			gatewayLogId: headerValue(headers, 'cf-aig-log-id') ?? nestedDetails?.gatewayLogId,
			retryAfter: headerValue(headers, 'retry-after') ?? nestedDetails?.retryAfter,
		};
	}
	return nestedDetails;
}

export function coreAiRequestOptions(env: CoreEnv, context: CoreAiRequestContext) {
	const environment = env.AI_GATEWAY_ENVIRONMENT.trim();
	const feature = context.feature.trim();
	if (!environment) throw new Error('AI Gateway environment is required');
	if (!feature) throw new Error('AI Gateway feature is required');
	return {
		gateway: {
			id: CORE_AI_GATEWAY_ID,
			collectLog: true,
			// Workflow steps own durable retries. Keep each Gateway request to one
			// provider attempt so dashboard policy cannot multiply paid inference.
			retries: { maxAttempts: 1 },
			metadata: {
				feature,
				environment,
				...(context.resourceId ? { resource_id: context.resourceId } : {}),
			},
		},
		extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
	} satisfies AiOptions;
}

export function throwCoreAiError(env: CoreEnv, error: unknown, context: CoreAiErrorContext): never {
	const details = rateLimitDetails(error);
	if (!details) throw error;
	const gatewayLogId = details.gatewayLogId ?? context.bindingGatewayLogId ?? undefined;
	console.error({
		tag: 'AI_TEMPORARILY_LIMITED',
		msg: 'Core inference hit an upstream AI limit',
		environment: env.AI_GATEWAY_ENVIRONMENT,
		feature: context.feature,
		gateway: CORE_AI_GATEWAY_ID,
		gatewayLogId,
		model: context.model,
		resource_id: context.resourceId,
		retry_after: details.retryAfter,
	});
	throw error;
}

async function runModel<Result>(env: CoreEnv, model: CoreAiModel, inputs: object, context: CoreAiRequestContext): Promise<Result> {
	const previousGatewayLogId = env.AI.aiGatewayLogId;
	try {
		return await (env.AI as WorkersAiRunner).run<Result>(model, inputs, coreAiRequestOptions(env, context));
	} catch (error) {
		const bindingGatewayLogId = env.AI.aiGatewayLogId;
		throwCoreAiError(env, error, {
			...context,
			model,
			bindingGatewayLogId: bindingGatewayLogId !== previousGatewayLogId ? bindingGatewayLogId : undefined,
		});
	}
}

export async function generateText(env: CoreEnv, prompt: string, options: GenerateTextOptions): Promise<string> {
	const { feature, systemPrompt } = options;
	const messages: AiMessage[] = [
		...(systemPrompt ? [{ role: 'system', content: systemPrompt } as const] : []),
		{ role: 'user', content: prompt },
	];
	const inputs = {
		messages,
		...(options.maxTokens != null && { max_tokens: options.maxTokens }),
		temperature: options.temperature ?? 0.3,
	};

	const response = await runModel<WorkersAiChatResponse>(env, CORE_TEXT_MODEL, inputs, options);
	const choice = response.choices?.[0];
	// Hitting the cap used to be invisible: the cut-off text was joined into the
	// final translation and persisted as if complete, and the <20% partial-refresh
	// guard never fires for an article that merely lost its last chunk. Throwing
	// retries the step, and an exhausted retry leaves the row untranslated rather
	// than silently half-translated.
	if (choice?.finish_reason === 'length') {
		throw new Error(`AI output hit the ${options.maxTokens ?? 'default'} token cap for ${feature}; refusing to persist a truncated result`);
	}
	const text = (choice?.message?.content ?? response.response ?? '').trim();
	if (!text) throw new Error(`AI Gateway returned no text for ${feature}`);
	return text;
}

export async function generateObject<T>(env: CoreEnv, prompt: string, options: GenerateObjectOptions<T>): Promise<T> {
	const { feature, schema, systemPrompt } = options;
	const schemaName = feature.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
	if (!schemaName) throw new Error(`AI feature ${feature} has no valid schema name`);
	const messages: AiMessage[] = [
		...(systemPrompt ? [{ role: 'system', content: systemPrompt } as const] : []),
		{ role: 'user', content: prompt },
	];

	const response = await runModel<WorkersAiChatResponse>(
		env,
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
		options,
	);
	const text = response.choices?.[0]?.message?.content?.trim();
	if (!text) throw new Error(`AI Gateway returned no structured output for ${feature}`);
	return schema.parse(JSON.parse(text));
}
