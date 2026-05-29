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
import { getSkill } from '../../agent/skills';
import {
	ALL_TOOL_NAMES,
	buildEnabledTools,
	canUseTool,
	isValidToolName,
	type ToolContext,
	type ToolName,
} from '../../agent/tools/registry';
import { logError } from '../../infra/log';
import { getOpenRouter } from '../../lib/ai/models';
import { buildMessages, buildUnifiedContext } from '../../lib/ai/prompts';
import { getSession } from '../../lib/auth';
import { validateModel } from '../../lib/billing/plans';
import { billing, QuotaExceededError } from '../../lib/billing/server';
import { createSession, findSession } from '../../lib/chat/sessions';
import { getCorsHeaders } from '../../lib/cors';
import { capturePostHogEvent } from '../../lib/tracking/posthog';
import { buildWorkspaceCatalogPrompt, listWorkspacesForAI } from '../../lib/workspace/aiCatalog';
import { getWorkspaceContextSummary } from '../../lib/workspace/aiContext';
import type { Env, ExecutionContext } from '../../models/types';
import { ContextItemSchema } from '../../types/context';
import { parseJsonBody } from '../middleware/auth';
import { buildCompletionEvent, extractTextFromParts, type FinishCapture, persistAssistantTurn, persistUserTurn } from './chat.persist';

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
	// Mirror of frontend CHAT_SCOPE_KINDS / route ChatRequestSchema. The worker
	// only acts on `kind === 'workspace'` (inject the workspace context summary);
	// workspace binding itself still flows through top-level `workspaceId`.
	scope: z
		.object({
			kind: z.enum(['home', 'feed', 'article', 'workspace', 'document', 'chat', 'unknown']),
			workspaceId: z.string().optional(),
			articleId: z.string().optional(),
			documentId: z.string().optional(),
		})
		.optional(),
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

/**
 * Mirror of Vercel route's `applySkillTools`: when a skill preset is active,
 * add the skill's required tools (still plan-gated via `canUseTool`) and drop
 * `load-skill` — the skill is already loaded so the model shouldn't re-fetch it.
 */
function applySkillTools(promptId: string | undefined, toolNames: ToolName[], planId: string): ToolName[] {
	const skill = promptId ? getSkill(promptId) : undefined;
	if (!skill) return toolNames;
	const out = new Set<ToolName>(toolNames);
	if (skill.meta.tools) {
		for (const t of skill.meta.tools) {
			if (isValidToolName(t) && canUseTool(planId, t)) out.add(t);
		}
	}
	out.delete('load-skill');
	return [...out];
}

/**
 * Resolve the request against the user's plan — mirror of Vercel
 * `resolveChatRequest`. The worker is publicly reachable and authed by a
 * client-held bearer token, so it can't trust the frontend's filtering:
 * downgrade a disallowed model, plan-gate the requested tools, then fold in
 * skill-required tools. Pure; takes the already-loaded `planId`.
 */
function resolveChatRequest(args: { planId: string; requestedModel?: string; requestedToolNames: ToolName[]; promptId?: string }): {
	effectiveModel: string;
	finalToolNames: ToolName[];
} {
	const { planId, requestedModel, requestedToolNames, promptId } = args;
	const effectiveModel = validateModel(planId, requestedModel ?? DEFAULT_MODEL);
	const finalToolNames = applySkillTools(
		promptId,
		requestedToolNames.filter((n) => canUseTool(planId, n)),
		planId,
	);
	return { effectiveModel, finalToolNames };
}

type ChatRequestData = z.output<typeof ChatRequestSchema>;

/**
 * Validate config + body + schema in one place. Returns the parsed request, or
 * a ready-to-send error Response (503 unconfigured / 400 malformed). Keeps the
 * main handler's branch count down.
 */
async function validateChatBody(request: Request, env: Env, cors: Record<string, string>): Promise<ChatRequestData | Response> {
	if (!env.OPENROUTER_API_KEY) {
		logError('CHAT', 'OPENROUTER_API_KEY not configured');
		return Response.json(
			{ success: false, error: { code: 'CONFIG', message: 'Chat is not configured on this worker' } },
			{ status: 503, headers: cors },
		);
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
	return parsed.data;
}

/**
 * Server-side credit pre-check against the already-loaded settings row (no extra
 * DB read). Returns a 403 in the frontend-compatible `{ ok: false, error }`
 * envelope when the balance can't cover the request — which trips the same
 * `isUpgradeRequiredError` upgrade UI the Vercel route does (see frontend
 * `fetcher.ts`). Returns null to proceed. Non-quota errors propagate.
 */
function enforceChatQuota(
	cors: Record<string, string>,
	settings: Awaited<ReturnType<typeof billing.getSettings>>,
	params: { model: string; messages: UIMessage[]; customInput?: string },
): Response | null {
	try {
		billing.assertChatQuota(settings, params);
		return null;
	} catch (err) {
		if (!(err instanceof QuotaExceededError)) throw err;
		const usage = billing.usageSnapshot(settings);
		return Response.json(
			{
				ok: false,
				error: {
					code: 'QUOTA_EXCEEDED',
					message: 'Quota exceeded',
					details: { requiresUpgrade: usage.planType === 'free', currentUsage: usage },
				},
			},
			{ status: 403, headers: cors },
		);
	}
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

	const validated = await validateChatBody(request, env, cors);
	if (validated instanceof Response) return validated;

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
		scope,
	} = validated;
	const effectiveLanguage = language ?? 'zh';
	// Name-validated but NOT yet plan-gated — the worker is a publicly reachable
	// endpoint authed by a client-held bearer token, so we can't trust the
	// frontend's filtering. Gated below once `planId` is known.
	const requestedToolNames: ToolName[] =
		toolsRequested && toolsRequested.length > 0 ? toolsRequested.filter(isValidToolName) : ALL_TOOL_NAMES;

	const startTime = Date.now();
	let errorInfo: { phase: 'streamText' | 'uiStream'; message: string } | null = null;

	// `create-document` is never plan-gated, so deciding the catalog fetch on the
	// pre-gate list is equivalent to deciding it post-gate — lets us keep `planId`
	// in the same parallel wave instead of awaiting it first.
	const needsWorkspaceCatalog = !workspaceId && requestedToolNames.includes('create-document');
	// The inverse case: workspace context summary only when the chat is bound to a
	// workspace via `scope.kind === 'workspace'`. Mutually exclusive with the
	// catalog, so both fold into the same wave.
	const needsWorkspaceSummary = scope?.kind === 'workspace' && !!workspaceId;

	// All reads are independent — fold them into one wave to keep the pre-stream
	// path at a single Hyperdrive RTT. `settings` is the single read that drives
	// planId + the quota gate + the 403 snapshot (no per-concern re-reads).
	// `null` / `[]` fallbacks so a transient DB blip never blocks the chat
	// opening — except settings, where null means fail-closed at the gate below.
	const [settings, existingSession, workspaceCatalogEntries, workspaceContextSummary] = await Promise.all([
		billing.getSettings(env, session.userId).catch(() => null),
		sessionId ? findSession(env, sessionId, session.userId).catch(() => null) : Promise.resolve(null),
		needsWorkspaceCatalog ? listWorkspacesForAI(env, session.userId).catch(() => []) : Promise.resolve([]),
		needsWorkspaceSummary && workspaceId
			? getWorkspaceContextSummary(env, workspaceId, session.userId).catch(() => null)
			: Promise.resolve(null),
	]);
	if (sessionId && !existingSession) {
		return Response.json(
			{ success: false, error: { code: 'NOT_FOUND', message: 'Chat session not found' } },
			{ status: 404, headers: cors },
		);
	}

	// Enforce the plan gates the frontend can't be trusted to apply: downgrade a
	// disallowed model + plan-gate tools. `finalToolNames` drives the prompt,
	// analytics, and the actual tool build so all three stay consistent.
	const planId = settings?.planId ?? 'free';
	const { effectiveModel, finalToolNames } = resolveChatRequest({ planId, requestedModel: model, requestedToolNames, promptId });

	// Server-side credit gate against the single settings read above. The worker
	// owns billing on its own path — it can NOT trust the browser to pre-check
	// quota (the bearer token lets a client hit this endpoint directly), so the
	// balance is enforced here and credits are deducted post-stream.
	const quotaDenied = enforceChatQuota(cors, settings, { model: effectiveModel, messages, customInput });
	if (quotaDenied) return quotaDenied;

	const chatSession =
		existingSession ??
		(await createSession(env, {
			userId: session.userId,
			model: effectiveModel,
			workspaceId: workspaceId ?? null,
		}));
	const effectiveSessionId = chatSession.id;

	// Build the enriched system prompt + user content. Mirrors Vercel:
	//   1. attached resources + workspace summary → context block in user content
	//   2. workspace catalog (when scope-free + create-document) → system block
	//   3. tool guidance + base prompt + language directive → system
	// `userContent` is folded back onto the last user message via
	// `injectUserContent` so the AI sees the enriched text in the conversation,
	// not a separate orphan message.
	const workspaceCatalog = needsWorkspaceCatalog ? buildWorkspaceCatalogPrompt({ entries: workspaceCatalogEntries, planId }) : undefined;
	const articlesContext = contextItems?.length ? buildUnifiedContext(contextItems) : undefined;
	const combinedContext = [workspaceContextSummary, articlesContext].filter(Boolean).join('\n\n') || undefined;

	const { system: systemPrompt, userContent: enrichedUserContent } = buildMessages({
		preset: promptId,
		extraContext: combinedContext,
		customInput,
		language: effectiveLanguage,
		enabledToolNames: finalToolNames,
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
				tools: finalToolNames,
				session_id: effectiveSessionId,
				prompt_id: promptId,
			},
		}),
	);

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
			const tools = buildEnabledTools(finalToolNames, toolCtx);

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
			// Usage is billed server-side in `persistAssistantTurn` (atomic deduct
			// against credit_balance) — the worker no longer emits a `data-usage`
			// part for the client to self-report, so the deduction can't be
			// skipped by a client that drops the track call.
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
					completed: !isAborted && !errorInfo,
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
				tools: finalToolNames,
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
