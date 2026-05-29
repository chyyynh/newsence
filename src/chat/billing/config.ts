// Static billing config — MIRROR OF the frontend's per-model pricing
// (frontend/src/lib/config/models.ts) + per-plan entitlements
// (frontend/src/lib/billing/plans.ts). Pure data + pure lookups, no DB.
//
// The worker chat endpoint (#136) is publicly reachable and authed by a
// client-held bearer token, so it can't trust the frontend to gate models or
// price usage — both happen here. Keep rates, aliases, gates, quotas, and the
// model allowlist in sync with the frontend on any model add or price change.
//
// Worker uses plain numbers instead of Prisma.Decimal — Postgres numeric(10,6)
// parses floats fine and accumulation is single-digit USD per session.

import { DEFAULT_CHAT_MODEL } from '../ai/models';

// ── Pricing ──────────────────────────────────────────────────

const MODEL_ID_ALIASES: Record<string, string> = {
	'gemini-3.1-pro': 'google/gemini-3.1-pro-preview',
	'gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite-preview',
	'claude-sonnet': 'anthropic/claude-sonnet-4-6',
	'claude-opus': 'anthropic/claude-opus-4-6',
	'gpt-5.4': 'openai/gpt-5.4',
};

/** USD per 1M input / output tokens. */
const TEXT_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
	'google/gemini-3.1-pro-preview': { inputPerMillion: 2.0, outputPerMillion: 12.0 },
	'google/gemini-3.1-flash-lite-preview': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
	'google/gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
	'anthropic/claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
	'anthropic/claude-opus-4-6': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
	'openai/gpt-5.4': { inputPerMillion: 1.75, outputPerMillion: 14.0 },
};

/** USD per generated image. Mirrors modelConfigs[...].pricing.image on the frontend. */
const IMAGE_PRICING: Record<string, { perImage: number }> = {
	'google/gemini-3-pro-image-preview': { perImage: 0.2 },
};

export function calculateTextCost(modelId: string, inputTokens: number, outputTokens: number): number {
	const pricing = TEXT_PRICING[MODEL_ID_ALIASES[modelId] ?? modelId];
	if (!pricing) throw new Error(`Unknown model "${modelId}" — not registered in worker pricing table`);
	return (inputTokens / 1_000_000) * pricing.inputPerMillion + (outputTokens / 1_000_000) * pricing.outputPerMillion;
}

export function calculateImageCost(modelId: string, count = 1): number {
	const pricing = IMAGE_PRICING[MODEL_ID_ALIASES[modelId] ?? modelId];
	if (!pricing) throw new Error(`Unknown image model "${modelId}" — not registered in worker pricing table`);
	return pricing.perImage * count;
}

// ── Plan gates ───────────────────────────────────────────────

interface PlanGates {
	deepResearch: boolean;
	imageGeneration: boolean;
	privateDocuments: boolean;
	privateCollections: boolean;
	externalSearch: boolean;
	customFeeds: boolean;
}

const FREE_GATES: PlanGates = {
	deepResearch: false,
	imageGeneration: false,
	privateDocuments: false,
	privateCollections: false,
	externalSearch: false,
	customFeeds: false,
};

const PRO_GATES: PlanGates = {
	deepResearch: true,
	imageGeneration: true,
	privateDocuments: true,
	privateCollections: true,
	externalSearch: true,
	customFeeds: true,
};

export type PlanGate = keyof PlanGates;

const PLAN_GATE_MAP: Record<string, PlanGates> = {
	free: FREE_GATES,
	pro: PRO_GATES,
	test: PRO_GATES,
};

export const getPlanGates = (planId: string): PlanGates => PLAN_GATE_MAP[planId] ?? FREE_GATES;

// ── Plan quotas ──────────────────────────────────────────────

interface PlanQuotas {
	maxWorkspaces: number | null;
}

const FREE_QUOTAS: PlanQuotas = { maxWorkspaces: 5 };
const PRO_QUOTAS: PlanQuotas = { maxWorkspaces: null };

const PLAN_QUOTA_MAP: Record<string, PlanQuotas> = {
	free: FREE_QUOTAS,
	pro: PRO_QUOTAS,
	test: PRO_QUOTAS,
};

export const getPlanQuotas = (planId: string): PlanQuotas => PLAN_QUOTA_MAP[planId] ?? FREE_QUOTAS;

// ── Plan metadata (credit grant + display name) ──────────────
//
// The worker resets a user's balance to `monthlyCreditGrant` when their quota
// window rolls over (see `loadSettingsWithReset` in credits.ts), so these MUST
// match the Vercel values or a user's monthly balance would differ depending on
// which surface they hit first.

interface PlanMeta {
	displayName: string;
	monthlyCreditGrant: number;
}

const PLAN_META_MAP: Record<string, PlanMeta> = {
	free: { displayName: 'Free Plan', monthlyCreditGrant: 500 },
	pro: { displayName: 'Pro Plan', monthlyCreditGrant: 15_000 },
	test: { displayName: 'Test Plan', monthlyCreditGrant: 1_000_000 },
};

const DEFAULT_PLAN_META = PLAN_META_MAP.free;

export const getMonthlyCreditGrant = (planId: string): number => (PLAN_META_MAP[planId] ?? DEFAULT_PLAN_META).monthlyCreditGrant;
export const getPlanDisplayName = (planId: string): string => (PLAN_META_MAP[planId] ?? DEFAULT_PLAN_META).displayName;

// ── Model allowlist ──────────────────────────────────────────

// Per-plan model allowlist. `undefined` = no restriction, matching the frontend
// where only `free` pins `allowedModels`. Unknown plans fall through to
// `undefined` (unrestricted), but `getSettings` already defaults to `'free'`.
const PLAN_ALLOWED_MODELS: Record<string, string[] | undefined> = {
	free: ['google/gemini-3.1-flash-lite-preview'],
	pro: undefined,
	test: undefined,
};

/**
 * Mirror of frontend `validateModel`: if the requested model isn't in the
 * plan's allowlist, downgrade to the first allowed model (never reject).
 */
export function validateModel(planId: string, modelId: string): string {
	const allowed = PLAN_ALLOWED_MODELS[planId];
	if (!allowed || allowed.includes(modelId)) return modelId;
	return allowed[0] ?? DEFAULT_CHAT_MODEL;
}
