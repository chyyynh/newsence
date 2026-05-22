/**
 * POST /api/chat — worker chat endpoint (issue #136).
 *
 * Phases landed so far:
 *   - 1: scaffold + CORS + request validation
 *   - 2-3: better-auth bearer-token validation (drizzle + Hyperdrive)
 *   - 4-5: real streamText via OpenRouter + full tool registry (8 tools)
 *   - 6a: chat session + message persistence
 *   - 6b: surface usage as transient `data-usage` part so the frontend can
 *         POST /api/ai/chat/track-usage. Billing pre-check and tracking are
 *         orchestrated by the frontend against existing Vercel routes; this
 *         handler stays billing-blind.
 *
 * Still missing (tracked in #136):
 *   - PostHog flush for ai_chat_completed (Phase 7)
 *   - Vercel feature-flag rollout (Phase 7)
 *   - System-prompt enrichment (workspace catalog, attached resources, tool
 *     guidance) — Vercel inline route still does this; needed for scope-free
 *     create-document to pick a valid workspaceId.
 *
 * History reads still go to Vercel `GET /api/ai/chat/[sessionId]`; both
 * writers hit the same Postgres rows so no migration of the reader is needed.
 */

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
import { ALL_TOOL_NAMES, buildEnabledTools, type ToolContext } from '../../agent/tools/registry';
import { logError } from '../../infra/log';
import { getOpenRouter } from '../../lib/ai/models';
import { getSession } from '../../lib/auth';
import { getUserPlanId } from '../../lib/billing/balance';
import { createSession, findSession, saveMessage, updateSessionStats } from '../../lib/chat/sessions';
import { getCorsHeaders } from '../../lib/cors';
import type { Env, ExecutionContext } from '../../models/types';
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

interface AssistantPart {
	type?: string;
	text?: string;
	[key: string]: unknown;
}

function extractTextFromParts(parts: ReadonlyArray<AssistantPart> | undefined): string {
	if (!parts?.length) return '';
	return parts
		.filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
		.map((p) => p.text)
		.join('');
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

	const { messages, sessionId, model, maxSteps, workspaceId, language, tools: toolsRequested } = parsed.data;
	const effectiveModel = model ?? DEFAULT_MODEL;

	// Both reads are independent of each other; run them in parallel so the
	// pre-stream path costs one Hyperdrive RTT instead of two. planId drives
	// per-plan tool gating; the session lookup decides "first turn" vs
	// "continuation". Falling back to `free` on planId error surfaces missing
	// rows as gated-tool denials rather than a 500.
	const [planId, existingSession] = await Promise.all([
		getUserPlanId(env, session.userId).catch(() => 'free'),
		sessionId ? findSession(env, sessionId, session.userId).catch(() => null) : Promise.resolve(null),
	]);
	if (sessionId && !existingSession) {
		return Response.json(
			{ success: false, error: { code: 'NOT_FOUND', message: 'Chat session not found' } },
			{ status: 404, headers: cors },
		);
	}
	const chatSession =
		existingSession ??
		(await createSession(env, {
			userId: session.userId,
			model: effectiveModel,
			workspaceId: workspaceId ?? null,
		}));
	const effectiveSessionId = chatSession.id;

	// Persist the user turn before opening the stream. The Vercel handler runs
	// extra context/skill injection here; the worker doesn't yet (Phases 4-5),
	// so we save the last user message verbatim. `metadata.displayContent`
	// mirrors Vercel's shape so the existing Vercel GET reader stays happy.
	const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
	const userContent = lastUserMessage ? extractTextFromParts(lastUserMessage.parts) : '';
	if (userContent) {
		await saveMessage(env, {
			sessionId: effectiveSessionId,
			role: 'user',
			content: userContent,
			metadata: { displayContent: userContent },
		});
	}

	const openrouter = getOpenRouter(env);

	interface FinishCapture {
		text: string;
		usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
		finishReason: string | null;
	}
	const finishCapture: FinishCapture = { text: '', usage: null, finishReason: null };

	const stream = createUIMessageStream({
		originalMessages: messages,
		execute: async ({ writer }) => {
			const toolCtx: ToolContext = {
				env,
				userId: session.userId,
				workspaceId: workspaceId ?? null,
				planId,
				streamWriter: writer,
				language: language ?? 'zh',
				requestSignal: request.signal,
			};
			const enabledNames = toolsRequested && toolsRequested.length > 0 ? toolsRequested : ALL_TOOL_NAMES;
			const tools = buildEnabledTools(enabledNames, toolCtx);

			const result = streamText({
				model: openrouter.chat(effectiveModel),
				messages: await convertToModelMessages(messages, tools ? { tools } : undefined),
				tools,
				// Forward client disconnect into the LLM call so OpenRouter usage
				// stops billing the moment the user cancels / closes the tab /
				// navigates away. Requires `enable_request_signal` +
				// `request_signal_passthrough` compat flags (see wrangler.jsonc).
				abortSignal: request.signal,
				stopWhen: stepCountIs(maxSteps ?? DEFAULT_MAX_STEPS),
				experimental_transform: smoothStream({ delayInMs: 2 }),
				onError: ({ error }) => {
					const msg = error instanceof Error ? error.message : String(error);
					logError('CHAT', 'streamText error', { sessionId: effectiveSessionId, userId: session.userId, error: msg });
				},
				onFinish: (res) => {
					finishCapture.text = res.text;
					finishCapture.usage = res.usage ?? null;
					finishCapture.finishReason = typeof res.finishReason === 'string' ? res.finishReason : null;
				},
			});
			writer.merge(result.toUIMessageStream({ sendReasoning: true }));
			await result.consumeStream();

			// Surface usage to the frontend as a transient data part so it can
			// fire-and-forget POST /api/ai/chat/track-usage from useChat's
			// onFinish. `transient: true` keeps it out of `responseMessage.parts`
			// per CLAUDE.md convention — we don't want token counts persisted
			// into chat_messages.metadata.
			if (finishCapture.usage?.inputTokens && finishCapture.usage?.outputTokens) {
				writer.write({
					type: 'data-usage',
					data: {
						inputTokens: finishCapture.usage.inputTokens,
						outputTokens: finishCapture.usage.outputTokens,
					},
					transient: true,
				});
			}
		},
		onError: (error) => {
			const msg = error instanceof Error ? error.message : 'Chat stream failed';
			logError('CHAT', 'UI stream error', { sessionId: effectiveSessionId, userId: session.userId, error: msg });
			return msg;
		},
		onFinish: ({ responseMessage, isAborted }) => {
			// Persist the assistant turn off the response path so the user
			// gets the connection closed promptly. waitUntil extends the
			// worker lifetime up to 30s after the response ends, which is
			// plenty for two short Postgres writes.
			ctx.waitUntil(
				persistAssistantTurn({
					env,
					session: chatSession,
					userId: session.userId,
					model: effectiveModel,
					responseMessage,
					finishCapture,
					isAborted,
				}).catch((err) => {
					logError('CHAT', 'persist assistant turn failed', {
						sessionId: effectiveSessionId,
						userId: session.userId,
						error: err instanceof Error ? err.message : String(err),
					});
				}),
			);
		},
	});

	return createUIMessageStreamResponse({
		stream,
		consumeSseStream: consumeStream,
		headers: { ...cors, 'X-Session-Id': effectiveSessionId, 'X-Model': effectiveModel },
	});
}

/**
 * Mirror the Vercel persist path: write the assistant row with `metadata.parts`
 * so the existing GET reader can reconstruct UIMessageStream parts, fire the
 * billing usage event back to Vercel, and update session totals — all in
 * parallel since they're independent writes.
 *
 * `total_cost` still isn't bumped here because the worker doesn't see the
 * USD-cost number (Vercel-side `billing.trackText` computes it from token
 * counts). For now `chat_sessions.total_cost` lags reality on the worker
 * path; the sessions list UI doesn't depend on it. Wire it up later if
 * needed by surfacing the cost in the trackText response.
 */
async function persistAssistantTurn(params: {
	env: Env;
	session: { id: string; totalTokens: number; totalCost: string };
	userId: string;
	model: string;
	responseMessage: { parts?: ReadonlyArray<AssistantPart> };
	finishCapture: {
		text: string;
		usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
		finishReason: string | null;
	};
	isAborted: boolean;
}): Promise<void> {
	const { env, session, userId, model, responseMessage, finishCapture, isAborted } = params;

	const text = finishCapture.text || extractTextFromParts(responseMessage.parts);
	const totalTokens = finishCapture.usage?.totalTokens ?? 0;
	const finishReason = finishCapture.finishReason ?? (isAborted ? 'aborted' : 'unknown');

	const metadata: Record<string, unknown> = {
		finishReason,
		model,
		status: isAborted ? 'aborted' : 'completed',
	};
	if (responseMessage.parts?.length) {
		metadata.parts = responseMessage.parts;
	}

	const ops: Promise<unknown>[] = [
		saveMessage(env, {
			sessionId: session.id,
			role: 'assistant',
			content: text,
			tokens: totalTokens || undefined,
			metadata,
		}),
	];

	if (totalTokens > 0) {
		const prevTokens = Number(session.totalTokens) || 0;
		const prevCost = Number.parseFloat(session.totalCost || '0') || 0;
		ops.push(
			updateSessionStats(env, session.id, userId, {
				totalTokens: prevTokens + totalTokens,
				totalCost: prevCost,
			}),
		);
	}

	await Promise.all(ops);
}
