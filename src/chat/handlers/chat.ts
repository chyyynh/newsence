/**
 * POST /api/chat — worker chat endpoint (issue #136).
 *
 * Thin HTTP adapter: CORS → auth → resolve → stream. The turn logic lives in
 * `chat.turn` (`resolveChatTurn` does everything before the stream opens;
 * `streamChatTurn` opens the model stream) and persistence + analytics in
 * `chat.persist`.
 *
 * Phases landed so far:
 *   - 1: scaffold + CORS + request validation
 *   - 2-3: better-auth bearer-token validation (drizzle + Hyperdrive)
 *   - 4-5: real streamText via OpenRouter + full tool registry (8 tools)
 *   - 6a: chat session + message persistence
 *   - 6b: usage surfaced for frontend track-usage (now superseded by 7's
 *         server-side billing)
 *   - 7: PostHog ai_chat_started + ai_chat_completed/error events, USD cost
 *        accumulation on chat_sessions.total_cost, server-side credit billing,
 *        and system-prompt enrichment (workspace catalog, attached resources,
 *        tool guidance) so scope-free create-document picks a real workspaceId.
 *
 * History reads still go to Vercel `GET /api/ai/chat/[sessionId]`; both writers
 * hit the same Postgres rows so no migration of the reader is needed.
 */

import { getSession } from '@shared/auth/session';
import { getCorsHeaders } from '@shared/cors';
import type { Env, ExecutionContext } from '@shared/types';
import { resolveChatTurn, streamChatTurn } from './chat.turn';

function buildCorsHeaders(request: Request, env: Env): Record<string, string> {
	// Auth is `Authorization: Bearer <session.token>` (better-auth bearer plugin),
	// not cookies — so no `Access-Control-Allow-Credentials` and the frontend
	// fetches without `credentials: 'include'`. Cross-subdomain cookie config
	// stays off, which also keeps a future WS upgrade path clean.
	return {
		...getCorsHeaders(request, env),
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		// Custom response headers the browser hides from JS by default. The
		// frontend's `promoteFromResponse` reads X-Session-Id (new chats →
		// onSessionCreated) and X-Model (server-side model resolution). Without
		// this header, response.headers.get() returns null cross-origin, which
		// breaks the worker-chat's track-usage path (sid in onFinish goes
		// undefined → no POST to /api/ai/chat/track-usage).
		'Access-Control-Expose-Headers': 'X-Session-Id, X-Model',
		'Access-Control-Max-Age': '86400',
	};
}

export async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const cors = buildCorsHeaders(request, env);

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: cors });
	}

	const session = await getSession(request, env);
	if (!session) {
		return Response.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, { status: 401, headers: cors });
	}

	const startTime = Date.now();
	const turn = await resolveChatTurn(request, env, session, cors);
	if (turn instanceof Response) return turn;

	return streamChatTurn({ request, env, ctx, userId: session.userId, cors, turn, startTime });
}
