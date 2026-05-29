/**
 * Worker billing facade — MIRROR OF frontend/src/lib/billing/server.ts.
 *
 * Single entry point for the worker chat path's billing. Pre-checks throw
 * `QuotaExceededError`, which the chat handler maps to the standard
 * `{ ok: false, error: { code: 'QUOTA_EXCEEDED' } }` 403 envelope so the
 * frontend's `isUpgradeRequiredError` upgrade flow lights up unchanged.
 * Tracking calls never throw — a failed deduction is logged, never surfaced to
 * the user — and additionally ingest a usage event to Polar for subscription
 * metering.
 */

import { logError } from '@shared/log';
import type { Env } from '@shared/types';
import { calculateImageCost, calculateTextCost } from './config';
import {
	checkBalance,
	costToCredits,
	estimateTokens,
	extractTextFromMessages,
	getSettings,
	OUTPUT_TOKEN_ESTIMATES,
	type SettingsRow,
	trackImage as trackImageUsage,
	trackText as trackTextUsage,
	usageSnapshot,
} from './credits';

// ── Polar usage-event ingestion ──────────────────────────────
//
// Bare REST instead of `@polar-sh/sdk` so the worker bundle stays small. Wire
// shape verified against the SDK's compiled `funcs/eventsIngest.js` +
// `EventCreateExternalCustomer$outboundSchema`:
//   POST {server}/v1/events/ingest
//   Authorization: Bearer <POLAR_API_KEY>
//   { events: [{ name, external_customer_id, metadata }] }   ← snake_case
//
// Fire-and-forget and never throws — metering must not affect the chat
// response. No-op when POLAR_API_KEY is unset (e.g. local dev), matching the
// frontend's `ingestToPolar` guard.

const POLAR_SERVER_URLS = {
	production: 'https://api.polar.sh',
	sandbox: 'https://sandbox-api.polar.sh',
} as const;

async function ingestPolarEvent(
	env: Env,
	name: string,
	userId: string,
	metadata: Record<string, string | number | boolean>,
): Promise<void> {
	const apiKey = env.POLAR_API_KEY;
	if (!apiKey) return;
	const base = env.POLAR_SERVER === 'sandbox' ? POLAR_SERVER_URLS.sandbox : POLAR_SERVER_URLS.production;

	try {
		const res = await fetch(`${base}/v1/events/ingest`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ events: [{ name, external_customer_id: userId, metadata }] }),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			logError('POLAR', 'ingest non-2xx', { name, status: res.status, body: text.slice(0, 200) });
		}
	} catch (err) {
		logError('POLAR', 'ingest failed', { name, error: err instanceof Error ? err.message : String(err) });
	}
}

export class QuotaExceededError extends Error {
	readonly code = 'QUOTA_EXCEEDED';
	constructor(
		readonly required: number,
		readonly balance: number,
	) {
		super(`Insufficient credit balance. Required ${required}, remaining ${balance}`);
		this.name = 'QuotaExceededError';
	}
}

// ── Shared balance gate ──────────────────────────────────
//
// Fresh-read quota check shared by the in-stream tools (create-document,
// generate-image) that don't carry the turn's settings row. It reads fresh —
// not the pre-loaded balance — because tools run deep in the stream, after any
// inline deductions earlier in the same turn (e.g. a prior generate-image) have
// already spent it down. The chat gate (`assertChatQuota`) checks the
// pre-loaded row instead, so it stays self-contained.

async function assertSufficientBalance(env: Env, userId: string, requiredCredits: number): Promise<void> {
	const { hasQuota, currentBalance } = await checkBalance(env, userId, requiredCredits);
	if (!hasQuota) throw new QuotaExceededError(requiredCredits, currentBalance);
}

export const billing = {
	// ── Settings (single read; derive planId + gate + snapshot from it) ──

	getSettings,
	usageSnapshot,

	// ── Pre-checks (throw QuotaExceededError) ──

	/**
	 * Pre-check chat quota against an already-loaded settings row (no DB read).
	 * Estimates input tokens from the message text + customInput, assumes a
	 * chat-sized output, and adds the same 1.3× headroom the Vercel route uses
	 * so a long response can't overrun the balance mid-stream. Fail-closed: a
	 * null settings row (load failed / no row) is treated as zero balance.
	 */
	assertChatQuota(settings: SettingsRow | null, params: { model: string; messages: unknown[]; customInput?: string }): void {
		const inputTokens = estimateTokens(
			`${extractTextFromMessages(Array.isArray(params.messages) ? params.messages : [])} ${params.customInput ?? ''}`,
		);
		const required = Math.ceil(costToCredits(calculateTextCost(params.model, inputTokens, OUTPUT_TOKEN_ESTIMATES.chat)) * 1.3);
		const balance = settings?.creditBalance ?? 0;
		if (balance < required) throw new QuotaExceededError(required, balance);
	},

	/**
	 * Pre-check for an in-stream text generation (create-document). Estimates
	 * output at the content-creation size; the real cost is billed by `trackText`
	 * afterwards. Reads fresh — see `assertSufficientBalance`.
	 */
	async checkText(env: Env, userId: string, model: string, prompt: string): Promise<void> {
		const required = costToCredits(calculateTextCost(model, estimateTokens(prompt), OUTPUT_TOKEN_ESTIMATES.content_creation));
		await assertSufficientBalance(env, userId, required);
	},

	async checkImage(env: Env, userId: string, model: string, count = 1): Promise<void> {
		await assertSufficientBalance(env, userId, costToCredits(calculateImageCost(model, count)));
	},

	// ── Tracking (never throws) ──

	async trackText(
		env: Env,
		params: { userId: string; model: string; inputTokens: number; outputTokens: number; meta?: Record<string, unknown> },
	): Promise<void> {
		try {
			await trackTextUsage(env, {
				userId: params.userId,
				model: params.model,
				inputTokens: params.inputTokens,
				outputTokens: params.outputTokens,
				metadata: params.meta,
			});
			await ingestPolarEvent(env, 'ai-text-generation', params.userId, {
				model: params.model,
				inputTokens: params.inputTokens,
				outputTokens: params.outputTokens,
				totalTokens: params.inputTokens + params.outputTokens,
			});
		} catch (error) {
			logError('BILLING', 'trackText failed', {
				userId: params.userId.slice(0, 8),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	async trackImage(env: Env, params: { userId: string; model: string; count?: number; meta?: Record<string, unknown> }): Promise<void> {
		try {
			await trackImageUsage(env, { userId: params.userId, model: params.model, count: params.count, metadata: params.meta });
			await ingestPolarEvent(env, 'ai-image-generation', params.userId, { model: params.model, count: params.count ?? 1 });
		} catch (error) {
			logError('BILLING', 'trackImage failed', {
				userId: params.userId.slice(0, 8),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},
} as const;
