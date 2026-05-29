/**
 * Chat turn engine for `POST /api/chat` (#136). Split out of the HTTP handler
 * (`chat.ts`) so the route file stays a thin adapter. Two phases:
 *
 *   - `resolveChatTurn` — everything before the stream opens: validate, the
 *     single-RTT read wave (`loadTurnInputs`), plan/model/tool gating, the
 *     quota gate, session create, prompt assembly (`buildEnrichedPrompt`), and
 *     the user-turn persist. Returns a ready-to-send error `Response`
 *     (503 / 400 / 404 / 403) or a fully-resolved `PreparedTurn`.
 *   - `streamChatTurn` — opens the model stream and wires the post-stream
 *     persist + analytics off the response path via `ctx.waitUntil`.
 *
 * The worker is publicly reachable and authed by a client-held bearer token, so
 * model/tool gating and the quota check can NOT be trusted to the frontend —
 * they are all re-enforced here. Persistence + analytics live in `chat.persist`.
 */

import { parseJsonBody } from '@shared/auth/middleware';
import type { WorkerSession } from '@shared/auth/session';
import { type ContextItem, ContextItemSchema } from '@shared/context';
import { logError } from '@shared/log';
import type { Env, ExecutionContext } from '@shared/types';
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
import { DEFAULT_CHAT_MODEL, getOpenRouter } from '../ai/models';
import { buildMessages, buildUnifiedContext } from '../ai/prompts';
import { validateModel } from '../billing/config';
import { billing, QuotaExceededError } from '../billing/server';
import { capturePostHogEvent } from '../posthog';
import { createSession, findSession } from '../sessions';
import { getSkill } from '../skills';
import { ALL_TOOL_NAMES, buildEnabledTools, canUseTool, isValidToolName, type ToolContext, type ToolName } from '../tools/registry';
import { buildWorkspaceCatalogPrompt, getWorkspaceContextSummary, listWorkspacesForAI, type WorkspaceCatalogEntry } from '../workspace-ai';
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

type ChatRequestData = z.output<typeof ChatRequestSchema>;

const DEFAULT_MAX_STEPS = 10;

// TODO: zh-Hant Intl.Segmenter chunking — runtime supports it, types don't.

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
 * `resolveChatRequest`: downgrade a disallowed model, plan-gate the requested
 * tools, then fold in skill-required tools. Pure; takes the loaded `planId`.
 */
function resolveChatRequest(args: { planId: string; requestedModel?: string; requestedToolNames: ToolName[]; promptId?: string }): {
	effectiveModel: string;
	finalToolNames: ToolName[];
} {
	const { planId, requestedModel, requestedToolNames, promptId } = args;
	const effectiveModel = validateModel(planId, requestedModel ?? DEFAULT_CHAT_MODEL);
	const finalToolNames = applySkillTools(
		promptId,
		requestedToolNames.filter((n) => canUseTool(planId, n)),
		planId,
	);
	return { effectiveModel, finalToolNames };
}

/**
 * Validate config + body + schema in one place. Returns the parsed request, or
 * a ready-to-send error Response (503 unconfigured / 400 malformed).
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

/**
 * One Hyperdrive RTT for everything the pre-stream path needs. All reads are
 * independent, so they fold into a single wave. `settings` drives planId + the
 * quota gate + the 403 snapshot (no per-concern re-reads). `null` / `[]`
 * fallbacks so a transient DB blip never blocks the chat opening — except
 * settings, where null means fail-closed at the quota gate.
 */
async function loadTurnInputs(
	env: Env,
	userId: string,
	args: { sessionId?: string; workspaceId?: string; needsWorkspaceCatalog: boolean; needsWorkspaceSummary: boolean },
) {
	const { sessionId, workspaceId, needsWorkspaceCatalog, needsWorkspaceSummary } = args;
	const [settings, existingSession, workspaceCatalogEntries, workspaceContextSummary] = await Promise.all([
		billing.getSettings(env, userId).catch(() => null),
		sessionId ? findSession(env, sessionId, userId).catch(() => null) : Promise.resolve(null),
		needsWorkspaceCatalog ? listWorkspacesForAI(env, userId).catch(() => []) : Promise.resolve([] as WorkspaceCatalogEntry[]),
		needsWorkspaceSummary && workspaceId ? getWorkspaceContextSummary(env, workspaceId, userId).catch(() => null) : Promise.resolve(null),
	]);
	return { settings, existingSession, workspaceCatalogEntries, workspaceContextSummary };
}

/**
 * Assemble the enriched system prompt + the messages the model actually sees.
 * Mirrors Vercel:
 *   1. attached resources + workspace summary → context block in user content
 *   2. workspace catalog (when scope-free + create-document) → system block
 *   3. tool guidance + base prompt + language directive → system
 * `userContent` is folded back onto the last user message via
 * `injectUserContent` so the AI sees the enriched text in the conversation, not
 * a separate orphan message. `persistedContent` is the user-visible text of
 * that last message (what gets written to the user turn).
 */
function buildEnrichedPrompt(args: {
	messages: UIMessage[];
	promptId?: string;
	customInput?: string;
	language: 'zh' | 'en';
	finalToolNames: ToolName[];
	planId: string;
	contextItems?: ContextItem[];
	needsWorkspaceCatalog: boolean;
	workspaceCatalogEntries: WorkspaceCatalogEntry[];
	workspaceContextSummary: string | null;
}): { system: string; uiMessages: UIMessage[]; persistedContent: string } {
	const workspaceCatalog = args.needsWorkspaceCatalog
		? buildWorkspaceCatalogPrompt({ entries: args.workspaceCatalogEntries, planId: args.planId })
		: undefined;
	const articlesContext = args.contextItems?.length ? buildUnifiedContext(args.contextItems) : undefined;
	const combinedContext = [args.workspaceContextSummary, articlesContext].filter(Boolean).join('\n\n') || undefined;

	const { system, userContent } = buildMessages({
		preset: args.promptId,
		extraContext: combinedContext,
		customInput: args.customInput,
		language: args.language,
		enabledToolNames: args.finalToolNames,
		workspaceCatalog,
	});

	const uiMessages = userContent ? injectUserContent(args.messages, userContent) : args.messages;
	const lastUserMessage = [...uiMessages].reverse().find((m) => m.role === 'user');
	const persistedContent = lastUserMessage ? extractTextFromParts(lastUserMessage.parts) : '';
	return { system, uiMessages, persistedContent };
}

/** Everything `streamChatTurn` needs once the pre-stream path has succeeded. */
export interface PreparedTurn {
	chatSession: Awaited<ReturnType<typeof createSession>>;
	effectiveModel: string;
	effectiveLanguage: 'zh' | 'en';
	finalToolNames: ToolName[];
	planId: string;
	systemPrompt: string;
	uiMessages: UIMessage[];
	workspaceId: string | null;
	promptId?: string;
	maxSteps?: number;
}

/**
 * Run the whole pre-stream path. Returns a ready-to-send error `Response`
 * (503 / 400 / 404 / 403) or a fully-resolved `PreparedTurn`. Persists the user
 * turn before returning so the stream opens against a row that already exists.
 */
export async function resolveChatTurn(
	request: Request,
	env: Env,
	session: WorkerSession,
	cors: Record<string, string>,
): Promise<Response | PreparedTurn> {
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
	// Name-validated but NOT yet plan-gated — the worker is publicly reachable and
	// authed by a client-held bearer token, so we can't trust the frontend's
	// filtering. Plan-gated below once `planId` is known.
	const requestedToolNames: ToolName[] =
		toolsRequested && toolsRequested.length > 0 ? toolsRequested.filter(isValidToolName) : ALL_TOOL_NAMES;

	// `create-document` is never plan-gated, so deciding the catalog fetch on the
	// pre-gate list is equivalent to deciding it post-gate — lets the read wave
	// run before `planId` is known. Catalog (scope-free) and summary
	// (workspace-bound) are mutually exclusive, so both fold into one wave.
	const needsWorkspaceCatalog = !workspaceId && requestedToolNames.includes('create-document');
	const needsWorkspaceSummary = scope?.kind === 'workspace' && !!workspaceId;

	const { settings, existingSession, workspaceCatalogEntries, workspaceContextSummary } = await loadTurnInputs(env, session.userId, {
		sessionId,
		workspaceId,
		needsWorkspaceCatalog,
		needsWorkspaceSummary,
	});
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

	// Server-side credit gate against the single settings read above — the worker
	// can NOT trust the browser to pre-check quota (the bearer token lets a client
	// hit this endpoint directly). Credits are deducted post-stream.
	const quotaDenied = enforceChatQuota(cors, settings, { model: effectiveModel, messages, customInput });
	if (quotaDenied) return quotaDenied;

	const chatSession =
		existingSession ?? (await createSession(env, { userId: session.userId, model: effectiveModel, workspaceId: workspaceId ?? null }));

	const { system, uiMessages, persistedContent } = buildEnrichedPrompt({
		messages,
		promptId,
		customInput,
		language: effectiveLanguage,
		finalToolNames,
		planId,
		contextItems,
		needsWorkspaceCatalog,
		workspaceCatalogEntries,
		workspaceContextSummary,
	});

	// Persist the user turn before opening the stream. Use the enriched content
	// (what the model actually sees) for `content`, but keep the raw user-typed
	// text in `metadata.displayContent` so the chat history UI doesn't render the
	// synthetic `# Attached Resources` block back to the user.
	if (persistedContent) {
		await persistUserTurn({ env, sessionId: chatSession.id, content: persistedContent, customInput, promptId, contextItems });
	}

	return {
		chatSession,
		effectiveModel,
		effectiveLanguage,
		finalToolNames,
		planId,
		systemPrompt: system,
		uiMessages,
		workspaceId: workspaceId ?? null,
		promptId,
		maxSteps,
	};
}

/**
 * Open the model stream for a resolved turn. Persist + analytics run off the
 * response path via `ctx.waitUntil` so the connection closes promptly.
 */
export function streamChatTurn(args: {
	request: Request;
	env: Env;
	ctx: ExecutionContext;
	userId: string;
	cors: Record<string, string>;
	turn: PreparedTurn;
	startTime: number;
}): Response {
	const { request, env, ctx, userId, cors, turn, startTime } = args;
	const {
		chatSession,
		effectiveModel,
		effectiveLanguage,
		finalToolNames,
		planId,
		systemPrompt,
		uiMessages,
		workspaceId,
		promptId,
		maxSteps,
	} = turn;
	const effectiveSessionId = chatSession.id;
	const openrouter = getOpenRouter(env);

	let errorInfo: { phase: 'streamText' | 'uiStream'; message: string } | null = null;

	// Fire ai_chat_started off the request path. Matches Vercel's event shape so
	// the same PostHog dashboards work for both surfaces.
	ctx.waitUntil(
		capturePostHogEvent(env, {
			distinctId: userId,
			event: 'ai_chat_started',
			properties: { model: effectiveModel, tools: finalToolNames, session_id: effectiveSessionId, prompt_id: promptId },
		}),
	);

	const finishCapture: FinishCapture = { text: '', usage: null, finishReason: null };

	const stream = createUIMessageStream({
		originalMessages: uiMessages,
		execute: async ({ writer }) => {
			const toolCtx: ToolContext = {
				env,
				userId,
				workspaceId,
				planId,
				streamWriter: writer,
				language: effectiveLanguage,
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
					logError('CHAT', 'streamText error', { sessionId: effectiveSessionId, userId, error: msg });
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
			logError('CHAT', 'UI stream error', { sessionId: effectiveSessionId, userId, error: msg });
			return msg;
		},
		onFinish: ({ responseMessage, isAborted }) => {
			// Persist the assistant turn off the response path so the user gets the
			// connection closed promptly. waitUntil extends the worker lifetime up to
			// 30s after the response ends, plenty for two short Postgres writes.
			ctx.waitUntil(
				persistAssistantTurn({
					env,
					session: chatSession,
					userId,
					model: effectiveModel,
					responseMessage,
					finishCapture,
					isAborted,
					completed: !isAborted && !errorInfo,
				}).catch((err) => {
					logError('CHAT', 'persist assistant turn failed', {
						sessionId: effectiveSessionId,
						userId,
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
			ctx.waitUntil(capturePostHogEvent(env, { distinctId: userId, event, properties }));
		},
	});

	return createUIMessageStreamResponse({
		stream,
		consumeSseStream: consumeStream,
		headers: { ...cors, 'X-Session-Id': effectiveSessionId, 'X-Model': effectiveModel },
	});
}
