// Worker tool-internal model resolver. `getOpenRouter` memoises the provider
// for the isolate's lifetime — the API key never rotates within a deploy, so
// creating a fresh OpenRouter client per `getModel` call (and per chat
// request) was pure waste.

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { Env } from '@shared/types';

export const DEFAULT_CHAT_MODEL = 'anthropic/claude-sonnet-4-6';

let cached: ReturnType<typeof createOpenRouter> | undefined;

export function getOpenRouter(env: Env) {
	if (!cached) cached = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
	return cached;
}

export function getModel(env: Env, modelId: string) {
	return getOpenRouter(env).chat(modelId);
}
