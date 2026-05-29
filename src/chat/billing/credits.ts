/**
 * Worker credit engine — MIRROR OF frontend/src/lib/billing/credits.ts.
 *
 * 1 credit = $0.001 USD (1000 credits = $1). The worker chat endpoint (#136) is
 * publicly reachable and authed by a client-held bearer token, so it can NOT
 * trust the browser to pre-check quota or report usage. Both the pre-stream
 * balance gate (`checkBalance`) and the post-stream deduction (`recordAndDeduct`)
 * run server-side here, against the same `user_settings` / `user_ai_usage` rows
 * the Vercel path writes — so the two surfaces stay consistent during the ramp.
 *
 * Raw `pg` instead of Prisma; column names are the real snake_case DB names.
 */

import { withClient, withTx } from '@shared/db/client';
import type { Env } from '@shared/types';
import type { Client } from 'pg';
import { calculateImageCost, calculateTextCost, getMonthlyCreditGrant, getPlanDisplayName } from './config';

// ── Constants ────────────────────────────────────────────

const CREDITS_PER_USD = 1000;
const CHARS_PER_TOKEN_EN = 4.0;
const CHARS_PER_TOKEN_CJK = 1.8;
const CJK_RE = /[一-鿿]/g;

/** Output-token estimates for pre-flight cost checks (real usage is billed after). */
export const OUTPUT_TOKEN_ESTIMATES = {
	content_creation: 1500,
	chat: 1000,
} as const;

// ── Token Estimation ─────────────────────────────────────

export function estimateTokens(text: string): number {
	if (!text) return 0;
	const cjkChars = (text.match(CJK_RE) || []).length;
	const ratio = cjkChars / text.length;
	const charsPerToken = CHARS_PER_TOKEN_EN - ratio * (CHARS_PER_TOKEN_EN - CHARS_PER_TOKEN_CJK);
	return Math.ceil(text.length / charsPerToken);
}

function extractTextFromMessage(message: unknown): string {
	if (!message || typeof message !== 'object') return '';
	const msg = message as Record<string, unknown>;
	if (typeof msg.content === 'string') return msg.content;
	if (Array.isArray(msg.parts)) {
		return msg.parts
			.filter((p): p is { type: 'text'; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text')
			.map((p) => (typeof p.text === 'string' ? p.text : ''))
			.join('');
	}
	return '';
}

export function extractTextFromMessages(messages: unknown[]): string {
	return messages.map(extractTextFromMessage).join(' ');
}

// ── Cost helpers ─────────────────────────────────────────

export function costToCredits(costUsd: number): number {
	return Math.ceil(costUsd * CREDITS_PER_USD);
}

// ── Settings + monthly reset ─────────────────────────────

export interface SettingsRow {
	creditBalance: number;
	creditsUsed: number;
	planId: string;
	subscriptionStatus: string;
	/** ISO date string (quota_reset_date is `@db.Date`) or null. */
	quotaResetDate: string | null;
}

const SETTINGS_COLS = `credit_balance AS "creditBalance", credits_used AS "creditsUsed",
	 plan_id AS "planId", subscription_status AS "subscriptionStatus", quota_reset_date AS "quotaResetDate"`;

function parseSettings(row: Record<string, unknown> | undefined): SettingsRow | null {
	if (!row) return null;
	return {
		creditBalance: Number(row.creditBalance ?? 0),
		creditsUsed: Number(row.creditsUsed ?? 0),
		planId: (row.planId as string | null) ?? 'free',
		subscriptionStatus: (row.subscriptionStatus as string | null) ?? 'inactive',
		quotaResetDate:
			row.quotaResetDate instanceof Date ? (row.quotaResetDate as Date).toISOString() : ((row.quotaResetDate as string | null) ?? null),
	};
}

/**
 * Load settings; if the monthly quota window has elapsed, reset + return the
 * refreshed row. Mirror of frontend `loadSettingsWithReset`, but the optimistic
 * guard is `quota_reset_date` ONLY (not `updated_at`): advancing the reset date
 * is itself the compare-and-swap, and avoids a timestamptz(6)-vs-JS-Date
 * precision mismatch that would make a cross-writer `updated_at` guard flaky.
 */
async function loadSettingsWithReset(client: Client, userId: string): Promise<SettingsRow | null> {
	const initial = parseSettings(
		(await client.query(`SELECT ${SETTINGS_COLS} FROM user_settings WHERE user_id = $1 LIMIT 1`, [userId])).rows[0],
	);
	if (!initial) return null;
	// Reset window not elapsed yet → use as-is. A null reset date means "never
	// scheduled"; leave it for the Vercel path / backfill rather than guess.
	if (!initial.quotaResetDate || new Date(initial.quotaResetDate) > new Date()) return initial;

	const grant = getMonthlyCreditGrant(initial.planId);
	const reset = await client.query(
		`UPDATE user_settings
		 SET credits_used = 0,
		     credit_balance = $2,
		     quota_reset_date = date_trunc('month', CURRENT_DATE + INTERVAL '1 month'),
		     updated_at = NOW()
		 WHERE user_id = $1 AND quota_reset_date = $3
		 RETURNING ${SETTINGS_COLS}`,
		[userId, grant, initial.quotaResetDate],
	);
	// Won the race → fresh row. Lost it (another request reset first) → re-read
	// so we return the post-reset balance, never the stale pre-reset one.
	if (reset.rowCount && reset.rows[0]) return parseSettings(reset.rows[0]);
	return parseSettings((await client.query(`SELECT ${SETTINGS_COLS} FROM user_settings WHERE user_id = $1 LIMIT 1`, [userId])).rows[0]);
}

/**
 * Public single-read entry: load the settings row (applying the monthly reset
 * if due) on its own connection. Callers derive planId, the quota gate, and the
 * usage snapshot from this one in-memory row instead of re-reading per concern.
 */
export async function getSettings(env: Env, userId: string): Promise<SettingsRow | null> {
	return withClient(env, (client) => loadSettingsWithReset(client, userId));
}

// ── Balance check ────────────────────────────────────────

interface BalanceCheck {
	hasQuota: boolean;
	requiredCredits: number;
	currentBalance: number;
}

export async function checkBalance(env: Env, userId: string, requiredCredits: number): Promise<BalanceCheck> {
	return withClient(env, async (client) => {
		const settings = await loadSettingsWithReset(client, userId);
		if (!settings) return { hasQuota: false, requiredCredits, currentBalance: 0 };
		return { hasQuota: settings.creditBalance >= requiredCredits, requiredCredits, currentBalance: settings.creditBalance };
	});
}

// ── Usage snapshot (for the 403 upgrade envelope) ────────

export interface UsageSnapshot {
	planType: string;
	planDisplayName: string;
	creditUsage: { balance: number; monthlyGrant: number; used: number; percentage: number };
	subscriptionStatus: string;
}

/** Pure derivation from an already-loaded settings row — no DB read. */
export function usageSnapshot(settings: SettingsRow | null): UsageSnapshot {
	const planId = settings?.planId ?? 'free';
	const monthlyGrant = getMonthlyCreditGrant(planId);
	const balance = settings?.creditBalance ?? 0;
	const used = settings?.creditsUsed ?? 0;
	return {
		planType: planId,
		planDisplayName: getPlanDisplayName(planId),
		creditUsage: { balance, monthlyGrant, used, percentage: monthlyGrant > 0 ? (used / monthlyGrant) * 100 : 0 },
		subscriptionStatus: settings?.subscriptionStatus ?? 'inactive',
	};
}

// ── Usage tracking (atomic record + deduct) ──────────────

interface RecordAndDeductInput {
	userId: string;
	serviceType: 'text_tokens' | 'image_generations';
	modelName: string;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number;
	credits: number;
	costUsd: number;
	metadata?: Record<string, unknown>;
}

/**
 * Atomic: insert the usage row AND decrement the balance in one transaction.
 * The decrement is guarded by `credit_balance >= credits`; if the guard fails
 * (balance raced below the cost) the whole tx rolls back — no usage row, no
 * deduction — and we throw so the caller logs the gap. Mirrors the Prisma
 * `$transaction` in frontend `recordAndDeduct`.
 */
async function recordAndDeduct(env: Env, input: RecordAndDeductInput): Promise<void> {
	await withTx(env, async (client) => {
		await client.query(
			`INSERT INTO user_ai_usage
			 (user_id, service_type, model_name, input_tokens, output_tokens, total_tokens, credits_used, estimated_cost, request_metadata)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
			[
				input.userId,
				input.serviceType,
				input.modelName,
				input.inputTokens,
				input.outputTokens,
				input.totalTokens,
				input.credits,
				input.costUsd,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
		const result = await client.query(
			`UPDATE user_settings
			 SET credit_balance = credit_balance - $2, credits_used = credits_used + $2, updated_at = NOW()
			 WHERE user_id = $1 AND credit_balance >= $2`,
			[input.userId, input.credits],
		);
		if (!result.rowCount) throw new Error('Insufficient credit balance');
	});
}

export async function trackText(
	env: Env,
	params: { userId: string; model: string; inputTokens: number; outputTokens: number; metadata?: Record<string, unknown> },
): Promise<void> {
	const total = params.inputTokens + params.outputTokens;
	const costUsd = calculateTextCost(params.model, params.inputTokens, params.outputTokens);
	await recordAndDeduct(env, {
		userId: params.userId,
		serviceType: 'text_tokens',
		modelName: params.model,
		inputTokens: params.inputTokens,
		outputTokens: params.outputTokens,
		totalTokens: total,
		credits: costToCredits(costUsd),
		costUsd,
		metadata: params.metadata,
	});
}

export async function trackImage(
	env: Env,
	params: { userId: string; model: string; count?: number; metadata?: Record<string, unknown> },
): Promise<void> {
	const count = params.count ?? 1;
	const costUsd = calculateImageCost(params.model, count);
	await recordAndDeduct(env, {
		userId: params.userId,
		serviceType: 'image_generations',
		modelName: params.model,
		inputTokens: null,
		outputTokens: null,
		totalTokens: count,
		credits: costToCredits(costUsd),
		costUsd,
		metadata: params.metadata,
	});
}
