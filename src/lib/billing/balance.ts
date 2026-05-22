// Cheap balance / plan lookups. Full pricing config lives on Vercel (see
// frontend/src/lib/billing/pricing.ts); the worker only needs to gate
// generate-image before burning a paid OpenRouter request and to drive
// per-plan tool gating in the registry.

import type { Env } from '../../models/types';
import { withClient } from '../db/client';

export async function getCreditBalance(env: Env, userId: string): Promise<number> {
	return withClient(env, async (client) => {
		const result = await client.query<{ credit_balance: string | number | null }>(
			`SELECT credit_balance FROM user_settings WHERE user_id = $1 LIMIT 1`,
			[userId],
		);
		const raw = result.rows[0]?.credit_balance;
		if (raw === null || raw === undefined) return 0;
		const parsed = typeof raw === 'number' ? raw : Number(raw);
		return Number.isFinite(parsed) ? parsed : 0;
	});
}

export async function getUserPlanId(env: Env, userId: string): Promise<string> {
	return withClient(env, async (client) => {
		const result = await client.query<{ plan_id: string | null }>(`SELECT plan_id FROM user_settings WHERE user_id = $1 LIMIT 1`, [userId]);
		return result.rows[0]?.plan_id ?? 'free';
	});
}
