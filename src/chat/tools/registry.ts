// Worker-side tool registry. Same shape as
// frontend/src/lib/ai/tools/registry.ts so the chat handler can build tool
// sets from the same string keys the frontend already sends; the difference
// is the `ToolContext` carries `env` (for Hyperdrive / Workers AI / R2). The
// top-level streamText call owns client-abort propagation via its own
// `abortSignal`, so tools don't need to thread the signal themselves.

import type { Env } from '@shared/types';
import type { Tool, ToolExecutionOptions, ToolSet } from 'ai';
import { getPlanGates, type PlanGate } from '../billing/config';
import { createAddResourceTool } from './add-resource';
import { createDocumentTool } from './create-document';
import { createEditDocumentTool } from './edit-document';
import { createGenerateImageTool } from './generate-image';
import { createLoadSkillTool } from './load-skill';
import { createReadContextTool } from './read-context';
import { createSearchNewsTool } from './search-news';
import { createSearchWebTool } from './search-web';

export interface DataPartWriter {
	// The AI SDK constrains data-part type names to the `data-*` namespace.
	// Mirror that here so a typo in a tool's writer call surfaces at compile
	// time instead of being silently swallowed by the SDK at runtime.
	write: (part: { type: `data-${string}`; id?: string; data: unknown; transient?: boolean }) => void;
}

export interface ToolContext {
	env: Env;
	userId: string;
	workspaceId: string | null;
	planId: string;
	streamWriter?: DataPartWriter;
	language?: 'zh' | 'en';
}

// Same invariance trick the frontend registry uses: tool factories always
// set `execute`, and ai-sdk's Tool<I, O> is invariant — the `as
// ExecutableTool` cast in each registry entry is the price of one shared
// registry shape.
export type ExecutableTool = Tool<unknown, unknown> & {
	execute: (input: unknown, options: ToolExecutionOptions) => Promise<unknown>;
};

export interface ToolDefinition {
	factory: (ctx: ToolContext) => ExecutableTool | undefined;
	invocationLimit: number;
	gate?: PlanGate;
}

export const TOOL_REGISTRY = {
	'search-news': {
		factory: (ctx) => createSearchNewsTool(ctx.env) as ExecutableTool,
		invocationLimit: 5,
	},
	'search-web': {
		factory: (ctx) => createSearchWebTool(ctx.env) as ExecutableTool,
		invocationLimit: 2,
		gate: 'externalSearch',
	},
	'create-document': {
		factory: (ctx) => createDocumentTool(ctx) as ExecutableTool,
		invocationLimit: 3,
	},
	'edit-document': {
		factory: (ctx) => createEditDocumentTool(ctx.env, ctx.userId, ctx.streamWriter) as ExecutableTool,
		invocationLimit: 5,
	},
	'generate-image': {
		factory: (ctx) => createGenerateImageTool(ctx.env, ctx.userId) as ExecutableTool,
		invocationLimit: 2,
		gate: 'imageGeneration',
	},
	'add-resource': {
		factory: (ctx) => createAddResourceTool(ctx.env, ctx.userId) as ExecutableTool,
		invocationLimit: 5,
	},
	'read-context': {
		factory: (ctx) => createReadContextTool(ctx.env, ctx.userId) as ExecutableTool,
		invocationLimit: 5,
	},
	'load-skill': {
		factory: () => createLoadSkillTool() as ExecutableTool,
		invocationLimit: 2,
	},
} as const satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOL_REGISTRY;

export const ALL_TOOL_NAMES = Object.keys(TOOL_REGISTRY) as ToolName[];

export function isValidToolName(name: string): name is ToolName {
	return name in TOOL_REGISTRY;
}

export function canUseTool(planId: string, toolName: string): boolean {
	if (!isValidToolName(toolName)) return false;
	const def: ToolDefinition = TOOL_REGISTRY[toolName];
	return def.gate ? getPlanGates(planId)[def.gate] : true;
}

export function buildEnabledTools(toolNames: string[], ctx: ToolContext): ToolSet | undefined {
	const counts = new Map<string, number>();
	const enabledTools: ToolSet = {};
	const gates = getPlanGates(ctx.planId);

	for (const name of toolNames) {
		if (!isValidToolName(name)) continue;
		const def: ToolDefinition = TOOL_REGISTRY[name];
		if (def.gate && !gates[def.gate]) continue;
		const t = def.factory(ctx);
		if (!t) continue;

		const limit = def.invocationLimit;
		enabledTools[name] = {
			...t,
			execute: async (input: unknown, options: ToolExecutionOptions) => {
				const count = (counts.get(name) ?? 0) + 1;
				counts.set(name, count);
				if (count > limit) {
					throw new Error(
						`Tool "${name}" exceeded its per-request invocation limit (${limit}). ` +
							`Stop calling it and respond to the user with the results you already have.`,
					);
				}
				return t.execute(input, options);
			},
		};
	}

	return Object.keys(enabledTools).length > 0 ? enabledTools : undefined;
}
