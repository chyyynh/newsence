// Read-only subset of frontend/src/lib/billing/plans.ts. Subscription,
// Polar, and pricing configuration stay on Vercel.
//
// The worker chat endpoint (#136) is publicly reachable and authed by a
// client-held bearer token, so it can't trust the frontend to gate models.
// `validateModel` below mirrors the Vercel server-side enforcement
// (frontend/src/lib/billing/plans.ts). Keep `PLAN_ALLOWED_MODELS` in sync with
// the `allowedModels` fields on the frontend `PLANS` definition.

import { DEFAULT_CHAT_MODEL } from '../ai/models';

export interface PlanGates {
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

export interface PlanQuotas {
	maxWorkspaces: number | null;
}

const FREE_QUOTAS: PlanQuotas = { maxWorkspaces: 5 };
const PRO_QUOTAS: PlanQuotas = { maxWorkspaces: null };

// Monthly credit grant + display name per plan. Mirror of the `monthlyCreditGrant`
// / `displayName` fields on the frontend `PLANS` definition — the worker resets a
// user's balance to this grant when their quota window rolls over (see
// `loadSettingsWithReset` in credits.ts), so it MUST match the Vercel value or a
// user's monthly balance would differ depending on which surface they hit first.
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

export type PlanGate = keyof PlanGates;

const PLAN_GATE_MAP: Record<string, PlanGates> = {
	free: FREE_GATES,
	pro: PRO_GATES,
	test: PRO_GATES,
};

const PLAN_QUOTA_MAP: Record<string, PlanQuotas> = {
	free: FREE_QUOTAS,
	pro: PRO_QUOTAS,
	test: PRO_QUOTAS,
};

export const getPlanGates = (planId: string): PlanGates => PLAN_GATE_MAP[planId] ?? FREE_GATES;
export const getPlanQuotas = (planId: string): PlanQuotas => PLAN_QUOTA_MAP[planId] ?? FREE_QUOTAS;

// Per-plan model allowlist. `undefined` = no restriction (all models allowed),
// matching the frontend where only `free` pins `allowedModels`. Unknown plans
// fall through to `undefined` (unrestricted) just like the Vercel side, but
// `getUserPlanId` already defaults to `'free'` on lookup failure.
const PLAN_ALLOWED_MODELS: Record<string, string[] | undefined> = {
	free: ['google/gemini-3.1-flash-lite-preview'],
	pro: undefined,
	test: undefined,
};

export const getPlanAllowedModels = (planId: string): string[] | undefined => PLAN_ALLOWED_MODELS[planId];

/**
 * Mirror of frontend `validateModel`: if the requested model isn't in the
 * plan's allowlist, downgrade to the first allowed model (never reject).
 */
export function validateModel(planId: string, modelId: string): string {
	const allowed = getPlanAllowedModels(planId);
	if (!allowed || allowed.includes(modelId)) return modelId;
	return allowed[0] ?? DEFAULT_CHAT_MODEL;
}
