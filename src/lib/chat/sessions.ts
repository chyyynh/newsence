/**
 * Worker chat session/message persistence (Phase 6a of #136).
 *
 * Raw `pg` queries (not Drizzle) — consistent with `infra/db.ts`. Mirrors the
 * Vercel helpers in `frontend/src/lib/chat/sessions.ts` so both sides write
 * the same shape into the same Postgres tables (`chat_sessions`,
 * `chat_messages`). The Vercel `GET /api/ai/chat/[sessionId]` reader keeps
 * working unchanged because the rows look identical.
 *
 * Per-write `pg.Client` (no module-level pool) — matches `lib/auth/index.ts`.
 * Hyperdrive already pools globally; a long-lived Client would leak across
 * request contexts.
 */

import { Client } from 'pg';
import type { Env } from '../../models/types';

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

async function withClient<T>(env: Env, fn: (client: Client) => Promise<T>): Promise<T> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end().catch(() => {});
	}
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
 * Bump totals and `updated_at`. Vercel doesn't touch `total_messages` either
 * — it's effectively stale; left as-is to keep parity until both writers move
 * to a trigger or RPC.
 */
export async function updateSessionStats(
	env: Env,
	sessionId: string,
	userId: string,
	stats: { totalTokens: number; totalCost: number },
): Promise<void> {
	await withClient(env, async (client) => {
		await client.query(
			`UPDATE chat_sessions
			 SET total_tokens = $3, total_cost = $4, updated_at = NOW()
			 WHERE id = $1 AND user_id = $2`,
			[sessionId, userId, stats.totalTokens, stats.totalCost],
		);
	});
}
