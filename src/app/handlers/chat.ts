/**
 * POST /api/chat — worker chat endpoint (issue #136).
 *
 * Phases landed so far:
 *   - 1: scaffold + CORS + request validation
 *   - 2-3: better-auth-cloudflare cookie validation (drizzle + Hyperdrive)
 *   - 4: real streamText via OpenRouter + `load-skill` tool (this commit)
 *
 * Still missing (tracked in #136):
 *   - billing.checkChat() quota gate (Phase 6)
 *   - chat session/message persistence (Phase 6)
 *   - the other 7 tools (Phases 4-5)
 *   - ctx.waitUntil() flush for billing + PostHog (Phase 6)
 *   - Vercel feature-flag rollout (Phase 7)
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
	consumeStream,
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	smoothStream,
	stepCountIs,
	streamText,
	type UIMessage,
} from 'ai';
import { z } from 'zod';
import { createLoadSkillTool } from '../../agent/tools/load-skill';
import { logError } from '../../infra/log';
import { getSession } from '../../lib/auth';
import { getCorsHeaders } from '../../lib/cors';
import type { Env } from '../../models/types';
import { parseJsonBody } from '../middleware/auth';

const ChatRequestSchema = z.object({
	messages: z.array(z.custom<UIMessage>()),
	sessionId: z.string().optional(),
	model: z.string().optional(),
	promptId: z.string().optional(),
	customInput: z.string().optional(),
	language: z.enum(['zh', 'en']).optional(),
	tools: z.array(z.string()).optional(),
	maxSteps: z.number().int().min(1).max(20).optional(),
	workspaceId: z.string().uuid().optional(),
});

const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_MAX_STEPS = 10;

// TODO: zh-Hant Intl.Segmenter chunking — runtime supports it, types don't.
const TOOLS = { 'load-skill': createLoadSkillTool() };

function buildCorsHeaders(request: Request, env: Env): Record<string, string> {
	// Auth is `Authorization: Bearer <session.token>` (better-auth bearer plugin),
	// not cookies — so no `Access-Control-Allow-Credentials` and the frontend
	// fetches without `credentials: 'include'`. Cross-subdomain cookie config
	// stays off, which also keeps a future WS upgrade path clean.
	return {
		...getCorsHeaders(request, env),
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		'Access-Control-Max-Age': '86400',
	};
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
	const cors = buildCorsHeaders(request, env);

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: cors });
	}

	const session = await getSession(request, env);
	if (!session) {
		return Response.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, { status: 401, headers: cors });
	}

	const body = await parseJsonBody<unknown>(request, cors);
	if (body instanceof Response) return body;

	const parsed = ChatRequestSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid chat request body', issues: parsed.error.issues } },
			{ status: 400, headers: cors },
		);
	}

	if (!env.OPENROUTER_API_KEY) {
		logError('CHAT', 'OPENROUTER_API_KEY not configured');
		return Response.json(
			{ success: false, error: { code: 'CONFIG', message: 'Chat is not configured on this worker' } },
			{ status: 503, headers: cors },
		);
	}

	const { messages, sessionId, model, maxSteps } = parsed.data;
	const effectiveSessionId = sessionId ?? crypto.randomUUID();
	const effectiveModel = model ?? DEFAULT_MODEL;

	const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });

	const stream = createUIMessageStream({
		originalMessages: messages,
		execute: async ({ writer }) => {
			const result = streamText({
				model: openrouter.chat(effectiveModel),
				messages: await convertToModelMessages(messages, { tools: TOOLS }),
				tools: TOOLS,
				stopWhen: stepCountIs(maxSteps ?? DEFAULT_MAX_STEPS),
				experimental_transform: smoothStream({ delayInMs: 2 }),
				onError: ({ error }) => {
					const msg = error instanceof Error ? error.message : String(error);
					logError('CHAT', 'streamText error', { sessionId: effectiveSessionId, userId: session.userId, error: msg });
				},
			});
			writer.merge(result.toUIMessageStream({ sendReasoning: true }));
			await result.consumeStream();
		},
		onError: (error) => {
			const msg = error instanceof Error ? error.message : 'Chat stream failed';
			logError('CHAT', 'UI stream error', { sessionId: effectiveSessionId, userId: session.userId, error: msg });
			return msg;
		},
	});

	return createUIMessageStreamResponse({
		stream,
		consumeSseStream: consumeStream,
		headers: { ...cors, 'X-Session-Id': effectiveSessionId, 'X-Model': effectiveModel },
	});
}
