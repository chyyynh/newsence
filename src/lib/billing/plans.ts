// Read-only subset of frontend/src/lib/billing/plans.ts. Subscription,
// Polar, and pricing configuration stay on Vercel.

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
