// ─────────────────────────────────────────────────────────────
// OpenRouter API Client
// ─────────────────────────────────────────────────────────────

import type { OpenRouterResponse } from '../models/types';
import { logError } from './log';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;

const OPENROUTER_HEADERS = {
	'Content-Type': 'application/json',
	'HTTP-Referer': 'https://www.newsence.app',
	'X-Title': 'newsence',
};

export const AI_MODELS = {
	FLASH: 'google/gemini-3-flash-preview',
} as const;

export interface CallOpenRouterOptions {
	apiKey: string;
	model?: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	timeoutMs?: number;
}

export async function callOpenRouter(prompt: string, options: CallOpenRouterOptions): Promise<string | null> {
	const { apiKey, model = AI_MODELS.FLASH, maxTokens, temperature = 0.3, systemPrompt, timeoutMs = TIMEOUT_MS } = options;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const messages = systemPrompt
		? [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: prompt },
			]
		: [{ role: 'user', content: [{ type: 'text', text: prompt }] }];

	try {
		const response = await fetch(OPENROUTER_API, {
			method: 'POST',
			signal: controller.signal,
			headers: { ...OPENROUTER_HEADERS, Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				messages,
				...(maxTokens != null && { max_tokens: maxTokens }),
				temperature,
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			logError('AI', 'OpenRouter error', { status: response.status, body: errorBody });
			return null;
		}

		const data: OpenRouterResponse = await response.json();
		return data.choices?.[0]?.message?.content ?? null;
	} catch (error: unknown) {
		const err = error as Error;
		logError('AI', 'Request failed', { type: err.name === 'AbortError' ? 'timeout' : 'error', error: err.message });
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

export function extractJson<T>(text: string): T | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]) as T;
	} catch {
		return null;
	}
}
