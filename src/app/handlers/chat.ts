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
 *   - 7: PostHog ai_chat_started + ai_chat_completed/error events, USD cost
 *        accumulation on chat_sessions.total_cost, and system-prompt
 *        enrichment (workspace catalog, attached resources, tool guidance) so
 *        scope-free create-document picks a real workspaceId.
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
import { ALL_TOOL_NAMES, buildEnabledTools, isValidToolName, type ToolContext, type ToolName } from '../../agent/tools/registry';
import { logError } from '../../infra/log';
import { getOpenRouter } from '../../lib/ai/models';
import { buildMessages, buildUnifiedContext } from '../../lib/ai/prompts';
import { getSession } from '../../lib/auth';
import { getUserPlanId } from '../../lib/billing/balance';
import { calculateTextCost } from '../../lib/billing/pricing';
import { createSession, findSession, saveMessage, updateSessionStats } from '../../lib/chat/sessions';
import { getCorsHeaders } from '../../lib/cors';
import { capturePostHogEvent } from '../../lib/tracking/posthog';
import { buildWorkspaceCatalogPrompt, listWorkspacesForAI } from '../../lib/workspace/aiCatalog';
import type { Env, ExecutionContext } from '../../models/types';
import { ContextItemSchema } from '../../types/context';
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
	contextItems: z.array(ContextItemSchema).optional(),
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

async function persistUserTurn(params: {
	env: Env;
	sessionId: string;
	content: string;
	customInput?: string;
	promptId?: string;
	contextItems?: unknown[];
}): Promise<void> {
	const { env, sessionId, content, customInput, promptId, contextItems } = params;
	const displayContent = customInput || content;
	const metadata: Record<string, unknown> = {
		displayContent,
		chatRequest: {
			...(promptId && { promptId }),
			customInput: customInput ?? '',
			...(contextItems?.length && { contextItems }),
		},
	};
	if (contextItems?.length) metadata.contextItems = contextItems;
	await saveMessage(env, { sessionId, role: 'user', content, metadata });
}

interface CompletionEventInput {
	model: string;
	tools: ToolName[];
	sessionId: string;
	isAborted: boolean;
	errorInfo: { phase: 'streamText' | 'uiStream'; message: string } | null;
	startTime: number;
	usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
	finishReason: string | null;
	partsCount: number;
}

/**
 * Mirror of Vercel route's `after()` PostHog payload — keep status enum +
 * conditional field set aligned with the Vercel side so dashboards work
 * across both surfaces during the migration.
 */
function buildCompletionEvent(input: CompletionEventInput): {
	event: 'ai_chat_completed' | 'ai_chat_error';
	properties: Record<string, unknown>;
} {
	const { model, tools, sessionId, isAborted, errorInfo, startTime, usage, finishReason, partsCount } = input;
	const completed = !isAborted && !errorInfo;
	const status: 'completed' | 'aborted' | 'error' = errorInfo ? 'error' : isAborted ? 'aborted' : 'completed';
	const inputTokens = usage?.inputTokens ?? 0;
	const outputTokens = usage?.outputTokens ?? 0;
	const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
	let costUsd = 0;
	try {
		if (completed && totalTokens > 0) costUsd = calculateTextCost(model, inputTokens, outputTokens);
	} catch {
		// Already logged on the persist path; skip cost/credit fields here.
	}
	const properties: Record<string, unknown> = {
		model,
		tools,
		session_id: sessionId,
		status,
		duration_ms: Date.now() - startTime,
		parts_count: partsCount,
	};
	if (completed) {
		properties.input_tokens = inputTokens;
		properties.output_tokens = outputTokens;
		properties.total_tokens = totalTokens;
		properties.cost_usd = costUsd;
		properties.credits_used = Math.ceil(costUsd * 1000);
		properties.finish_reason = finishReason;
	}
	if (errorInfo) {
		properties.error_phase = errorInfo.phase;
		properties.error_message = errorInfo.message;
	}
	return { event: completed ? 'ai_chat_completed' : 'ai_chat_error', properties };
}

/**
 * Mirror of Vercel `injectUserContent` (route.ts:525) — splice enriched user
 * content onto the last non-assistant message so the model sees the attached
 * resources block + customInput inline. Non-text parts (e.g. attachments) on
 * the original message are preserved after the rewritten text part.
 */
function injectUserContent(rawMessages: UIMessage[], userContent: string): UIMessage[] {
	let lastUserIdx = -1;
	for (let i = rawMessages.length - 1; i >= 0; i--) {
		const role = rawMessages[i].role;
		if (role !== 'assistant' && role !== 'system') {
			lastUserIdx = i;
			break;
		}
	}
	if (lastUserIdx < 0) {
		return [...rawMessages, { id: `usr-${crypto.randomUUID()}`, role: 'user', parts: [{ type: 'text', text: userContent }] } as UIMessage];
	}
	return rawMessages.map((msg, i) => {
		if (i !== lastUserIdx) return msg;
		const nonText = (msg.parts ?? []).filter((p) => p.type !== 'text');
		return { ...msg, parts: [{ type: 'text' as const, text: userContent }, ...nonText] as UIMessage['parts'] };
	});
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

	const {
		messages,
		sessionId,
		model,
		promptId,
		customInput,
		maxSteps,
		workspaceId,
		language,
		tools: toolsRequested,
		contextItems,
	} = parsed.data;
	const effectiveModel = model ?? DEFAULT_MODEL;
	const effectiveLanguage = language ?? 'zh';
	const enabledToolNames: ToolName[] =
		toolsRequested && toolsRequested.length > 0 ? toolsRequested.filter(isValidToolName) : ALL_TOOL_NAMES;

	const startTime = Date.now();
	let errorInfo: { phase: 'streamText' | 'uiStream'; message: string } | null = null;

	// Catalog only needed when the chat isn't workspace-bound AND `create-document`
	// is enabled this turn — otherwise we'd burn a Hyperdrive RTT and pollute
	// the system prompt for nothing.
	const needsWorkspaceCatalog = !workspaceId && enabledToolNames.includes('create-document');

	// All three reads are independent — fold the catalog fetch into the same
	// wave to keep the pre-stream path at one Hyperdrive RTT. `[]` catalog
	// fallback so a transient DB blip never blocks the chat opening.
	const [planId, existingSession, workspaceCatalogEntries] = await Promise.all([
		getUserPlanId(env, session.userId).catch(() => 'free'),
		sessionId ? findSession(env, sessionId, session.userId).catch(() => null) : Promise.resolve(null),
		needsWorkspaceCatalog ? listWorkspacesForAI(env, session.userId).catch(() => []) : Promise.resolve([]),
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

	// Build the enriched system prompt + user content. Mirrors Vercel:
	//   1. attached resources → `# Attached Resources` block in user content
	//   2. workspace catalog (when scope-free + create-document) → system block
	//   3. tool guidance + base prompt + language directive → system
	// `userContent` is folded back onto the last user message via
	// `injectUserContent` so the AI sees the enriched text in the conversation,
	// not a separate orphan message.
	const workspaceCatalog = needsWorkspaceCatalog ? buildWorkspaceCatalogPrompt({ entries: workspaceCatalogEntries, planId }) : undefined;
	const articlesContext = contextItems?.length ? buildUnifiedContext(contextItems) : undefined;

	const { system: systemPrompt, userContent: enrichedUserContent } = buildMessages({
		preset: promptId,
		extraContext: articlesContext,
		customInput,
		language: effectiveLanguage,
		enabledToolNames,
		workspaceCatalog,
	});

	const uiMessages = enrichedUserContent ? injectUserContent(messages, enrichedUserContent) : messages;

	// Persist the user turn before opening the stream. Use the enriched content
	// (what the model actually sees) for `content`, but keep the raw user-typed
	// text in `metadata.displayContent` so the chat history UI doesn't render
	// the synthetic `# Attached Resources` block back to the user.
	const lastUserMessage = [...uiMessages].reverse().find((m) => m.role === 'user');
	const persistedContent = lastUserMessage ? extractTextFromParts(lastUserMessage.parts) : '';
	if (persistedContent) {
		await persistUserTurn({
			env,
			sessionId: effectiveSessionId,
			content: persistedContent,
			customInput,
			promptId,
			contextItems,
		});
	}

	const openrouter = getOpenRouter(env);

	// Fire ai_chat_started off the request path. Matches Vercel's event shape so
	// the same PostHog dashboards work for both surfaces. waitUntil keeps it from
	// blocking the stream open.
	ctx.waitUntil(
		capturePostHogEvent(env, {
			distinctId: session.userId,
			event: 'ai_chat_started',
			properties: {
				model: effectiveModel,
				tools: enabledToolNames,
				session_id: effectiveSessionId,
				prompt_id: promptId,
			},
		}),
	);

	interface FinishCapture {
		text: string;
		usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
		finishReason: string | null;
	}
	const finishCapture: FinishCapture = { text: '', usage: null, finishReason: null };

	const stream = createUIMessageStream({
		originalMessages: uiMessages,
		execute: async ({ writer }) => {
			const toolCtx: ToolContext = {
				env,
				userId: session.userId,
				workspaceId: workspaceId ?? null,
				planId,
				streamWriter: writer,
				language: effectiveLanguage,
				requestSignal: request.signal,
			};
			const tools = buildEnabledTools(enabledToolNames, toolCtx);

			const result = streamText({
				model: openrouter.chat(effectiveModel),
				system: systemPrompt,
				messages: await convertToModelMessages(uiMessages, tools ? { tools } : undefined),
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
					errorInfo = { phase: 'streamText', message: msg };
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
			// Don't clobber an upstream streamText error — UI stream errors are
			// usually a downstream consequence of the same underlying failure.
			if (!errorInfo) errorInfo = { phase: 'uiStream', message: msg };
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

			// Fire ai_chat_completed / ai_chat_error off the response path.
			const { event, properties } = buildCompletionEvent({
				model: effectiveModel,
				tools: enabledToolNames,
				sessionId: effectiveSessionId,
				isAborted,
				errorInfo,
				startTime,
				usage: finishCapture.usage,
				finishReason: finishCapture.finishReason,
				partsCount: responseMessage.parts?.length ?? 0,
			});
			ctx.waitUntil(capturePostHogEvent(env, { distinctId: session.userId, event, properties }));
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
 * `total_cost` is recomputed locally from the same per-model rate table Vercel
 * uses (`lib/billing/pricing.ts`); we deliberately don't piggy-back on the
 * Vercel `track-usage` response because that path is fire-and-forget from the
 * frontend and we'd lose the cost on aborted streams.
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
		const inputTokens = finishCapture.usage?.inputTokens ?? 0;
		const outputTokens = finishCapture.usage?.outputTokens ?? 0;
		// Unknown model id throws — swallow so persist still happens with token
		// counts and the session row stays roughly consistent. Loud log surfaces
		// the gap (most likely an unregistered model id) without breaking chat.
		let costUsd = 0;
		try {
			costUsd = calculateTextCost(model, inputTokens, outputTokens);
		} catch (err) {
			logError('CHAT', 'cost calc failed; total_cost not accumulated', {
				model,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		ops.push(
			updateSessionStats(env, session.id, userId, {
				totalTokens: prevTokens + totalTokens,
				totalCost: prevCost + costUsd,
			}),
		);
	}

	await Promise.all(ops);
}
