/**
 * Persistence + analytics helpers for the worker chat handler (#136).
 *
 * Split out of `chat.ts` to keep the request handler focused on request flow.
 * All billing is server-side and self-contained (see `persistAssistantTurn`):
 * `billing.trackText` atomically deducts against `user_settings.credit_balance`
 * — no client round-trip, so a client can't get free usage by dropping a call.
 */

import { logError } from '@shared/log';
import type { Env } from '@shared/types';
import { calculateTextCost } from '../billing/config';
import { billing } from '../billing/server';
import { saveMessage, updateSessionStats } from '../sessions';
import type { ToolName } from '../tools/registry';

export interface AssistantPart {
	type?: string;
	text?: string;
	[key: string]: unknown;
}

/** Captured from streamText's `onFinish` so the persist path can bill + record. */
export interface FinishCapture {
	text: string;
	usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
	finishReason: string | null;
}

export function extractTextFromParts(parts: ReadonlyArray<AssistantPart> | undefined): string {
	if (!parts?.length) return '';
	return parts
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
		.map((p) => p.text)
		.join('');
}

export async function persistUserTurn(params: {
	env: Env;
	sessionId: string;
	content: string;
	customInput?: string;
	promptId?: string;
	contextItems?: unknown[];
}): Promise<void> {
	const { env, sessionId, content, customInput, promptId, contextItems } = params;
	const displayContent = customInput || content;
	const metadata: Record<string, unknown> = {
		displayContent,
		chatRequest: {
			...(promptId && { promptId }),
			customInput: customInput ?? '',
			...(contextItems?.length && { contextItems }),
		},
	};
	if (contextItems?.length) metadata.contextItems = contextItems;
	await saveMessage(env, { sessionId, role: 'user', content, metadata });
}

export interface CompletionEventInput {
	model: string;
	tools: ToolName[];
	sessionId: string;
	isAborted: boolean;
	errorInfo: { phase: 'streamText' | 'uiStream'; message: string } | null;
	startTime: number;
	usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
	finishReason: string | null;
	partsCount: number;
}

/**
 * Mirror of Vercel route's `after()` PostHog payload — keep status enum +
 * conditional field set aligned with the Vercel side so dashboards work
 * across both surfaces during the migration.
 */
export function buildCompletionEvent(input: CompletionEventInput): {
	event: 'ai_chat_completed' | 'ai_chat_error';
	properties: Record<string, unknown>;
} {
	const { model, tools, sessionId, isAborted, errorInfo, startTime, usage, finishReason, partsCount } = input;
	const completed = !isAborted && !errorInfo;
	const status: 'completed' | 'aborted' | 'error' = errorInfo ? 'error' : isAborted ? 'aborted' : 'completed';
	const inputTokens = usage?.inputTokens ?? 0;
	const outputTokens = usage?.outputTokens ?? 0;
	const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
	let costUsd = 0;
	try {
		if (completed && totalTokens > 0) costUsd = calculateTextCost(model, inputTokens, outputTokens);
	} catch {
		// Already logged on the persist path; skip cost/credit fields here.
	}
	const properties: Record<string, unknown> = {
		model,
		tools,
		session_id: sessionId,
		status,
		duration_ms: Date.now() - startTime,
		parts_count: partsCount,
	};
	if (completed) {
		properties.input_tokens = inputTokens;
		properties.output_tokens = outputTokens;
		properties.total_tokens = totalTokens;
		properties.cost_usd = costUsd;
		properties.credits_used = Math.ceil(costUsd * 1000);
		properties.finish_reason = finishReason;
	}
	if (errorInfo) {
		properties.error_phase = errorInfo.phase;
		properties.error_message = errorInfo.message;
	}
	return { event: completed ? 'ai_chat_completed' : 'ai_chat_error', properties };
}

/**
 * Write the assistant row with `metadata.parts` so the existing GET reader can
 * reconstruct UIMessageStream parts, deduct credits (completed turns only), and
 * update session totals — all in parallel since they're independent writes.
 *
 * Billing is server-side and self-contained: `billing.trackText` atomically
 * deducts against `user_settings.credit_balance` and ingests a Polar metering
 * event. There is no client round-trip, so a client that drops a track call
 * can't get free usage. `total_cost` on the session row is a separate running
 * display total, recomputed from the same per-model rate table.
 */
export async function persistAssistantTurn(params: {
	env: Env;
	session: { id: string };
	userId: string;
	model: string;
	responseMessage: { parts?: ReadonlyArray<AssistantPart> };
	finishCapture: FinishCapture;
	isAborted: boolean;
	/** Clean finish — no client abort, no stream error. Only completed turns are credit-billed (matches Vercel). */
	completed: boolean;
}): Promise<void> {
	const { env, session, userId, model, responseMessage, finishCapture, isAborted, completed } = params;

	const text = finishCapture.text || extractTextFromParts(responseMessage.parts);
	const totalTokens = finishCapture.usage?.totalTokens ?? 0;
	const finishReason = finishCapture.finishReason ?? (isAborted ? 'aborted' : 'unknown');

	const metadata: Record<string, unknown> = {
		finishReason,
		model,
		status: isAborted ? 'aborted' : 'completed',
	};
	if (responseMessage.parts?.length) {
		metadata.parts = responseMessage.parts;
	}

	const ops: Promise<unknown>[] = [
		saveMessage(env, {
			sessionId: session.id,
			role: 'assistant',
			content: text,
			tokens: totalTokens || undefined,
			metadata,
		}),
	];

	if (totalTokens > 0) {
		const inputTokens = finishCapture.usage?.inputTokens ?? 0;
		const outputTokens = finishCapture.usage?.outputTokens ?? 0;
		// Unknown model id throws — swallow so persist still happens with token
		// counts and the session row stays roughly consistent. Loud log surfaces
		// the gap (most likely an unregistered model id) without breaking chat.
		let costUsd = 0;
		try {
			costUsd = calculateTextCost(model, inputTokens, outputTokens);
		} catch (err) {
			logError('CHAT', 'cost calc failed; total_cost not accumulated', {
				model,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		// Pass this turn's deltas — the accumulation is done atomically in SQL so
		// overlapping turns can't clobber each other's totals.
		ops.push(updateSessionStats(env, session.id, userId, { addTokens: totalTokens, addCost: costUsd }));

		// Deduct credits + ingest Polar metering — only for a clean completion,
		// matching the Vercel route (aborted/errored turns aren't user-billed even
		// though they may have burned upstream tokens). `trackText` is atomic and
		// never throws (the facade swallows + logs), so it's safe inside the wave.
		if (completed && inputTokens > 0 && outputTokens > 0) {
			ops.push(
				billing.trackText(env, {
					userId,
					model,
					inputTokens,
					outputTokens,
					meta: { endpoint: '/api/chat', sessionId: session.id },
				}),
			);
		}
	}

	await Promise.all(ops);
}
