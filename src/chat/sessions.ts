/**
 * Worker chat session/message persistence (Phase 6a of #136).
 *
 * Raw `pg` queries — consistent with `infra/db.ts`. Mirrors the Vercel
 * helpers in `frontend/src/lib/chat/sessions.ts` so both writers produce the
 * same row shape and the existing Vercel GET reader stays unchanged.
 */

import { withClient } from '@shared/db/client';
import type { Env } from '@shared/types';

interface ChatSessionRow {
	id: string;
	userId: string;
	workspaceId: string | null;
	title: string | null;
	model: string;
	totalTokens: number;
	/** numeric(10,6) — returned as string by node-postgres unless a parser is registered. */
	totalCost: string;
}

interface CreateSessionInput {
	userId: string;
	model: string;
	title?: string;
	workspaceId?: string | null;
}

interface SaveMessageInput {
	sessionId: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	tokens?: number;
	cost?: number;
	/** Plain object — helper stringifies before insert. */
	metadata?: Record<string, unknown> | null;
}

/**
 * Look up a session scoped to the owner. Returns null if not found or owned
 * by a different user — callers should not leak the distinction.
 */
export async function findSession(env: Env, sessionId: string, userId: string): Promise<ChatSessionRow | null> {
	return withClient(env, async (client) => {
		const result = await client.query(
			`SELECT id, user_id AS "userId", workspace_id AS "workspaceId", title, model,
			        total_tokens AS "totalTokens", total_cost AS "totalCost"
			 FROM chat_sessions
			 WHERE id = $1 AND user_id = $2
			 LIMIT 1`,
			[sessionId, userId],
		);
		return (result.rows[0] as ChatSessionRow | undefined) ?? null;
	});
}

export async function createSession(env: Env, input: CreateSessionInput): Promise<ChatSessionRow> {
	return withClient(env, async (client) => {
		const result = await client.query(
			`INSERT INTO chat_sessions (user_id, workspace_id, title, model)
			 VALUES ($1, $2, $3, $4)
			 RETURNING id, user_id AS "userId", workspace_id AS "workspaceId", title, model,
			           total_tokens AS "totalTokens", total_cost AS "totalCost"`,
			[input.userId, input.workspaceId ?? null, input.title ?? 'New Chat', input.model],
		);
		return result.rows[0] as ChatSessionRow;
	});
}

export async function saveMessage(env: Env, input: SaveMessageInput): Promise<void> {
	await withClient(env, async (client) => {
		await client.query(
			`INSERT INTO chat_messages (session_id, role, content, tokens, cost, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
			[
				input.sessionId,
				input.role,
				input.content,
				input.tokens ?? null,
				input.cost ?? null,
				input.metadata ? JSON.stringify(input.metadata) : null,
			],
		);
	});
}

/**
 * Bump totals and `updated_at`. `stats` are DELTAS for this turn — the
 * accumulation runs in SQL (`total_tokens + $3`) so two overlapping turns in
 * one session can't lose an update via a read-modify-write race. Vercel doesn't
 * touch `total_messages` either — it's effectively stale; left as-is to keep
 * parity until both writers move to a trigger or RPC.
 */
export async function updateSessionStats(
	env: Env,
	sessionId: string,
	userId: string,
	stats: { addTokens: number; addCost: number },
): Promise<void> {
	await withClient(env, async (client) => {
		await client.query(
			`UPDATE chat_sessions
			 SET total_tokens = total_tokens + $3, total_cost = total_cost + $4, updated_at = NOW()
			 WHERE id = $1 AND user_id = $2`,
			[sessionId, userId, stats.addTokens, stats.addCost],
		);
	});
}
