// Mirrors frontend/src/lib/ai/tools/create-document.ts. The internal
// streamText reuses the cached OpenRouter provider; workspace creation +
// doc insert run inside one pg transaction so a failed insert can't orphan
// a workspace.

import { withTx } from '@shared/db/client';
import { documentPath } from '@shared/ids';
import type { Env } from '@shared/types';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { DEFAULT_CHAT_MODEL, getModel } from '../ai/models';
import { getOutputLanguageInstruction } from '../ai/prompts';
import { billing } from '../billing/server';
import { markdownToLexicalJson } from '../editor/serverEditor';
import {
	commitNewWorkspaceForDoc,
	resolveExistingWorkspaceForDoc,
	validateNewWorkspaceForDoc,
	type WorkspacePlanForDoc,
} from '../workspace-ai';
import type { DataPartWriter, ToolContext } from './registry';

const baseShape = {
	title: z.string().describe('Document title'),
	prompt: z
		.string()
		.min(10)
		.describe(
			'Detailed writing instructions: structure, key points, tone, and any source material to incorporate. ' +
				'The AI generates the full content based on this.',
		),
};

const workspaceDecisionSchema = z
	.discriminatedUnion('mode', [
		z.object({
			mode: z.literal('existing'),
			workspaceId: z.string().uuid().describe('id of an existing workspace from the Workspace Catalog'),
		}),
		z.object({
			mode: z.literal('new'),
			title: z.string().min(1).max(120).describe('short, theme-descriptive workspace title'),
			description: z.string().max(500).optional().describe('one-sentence theme description, helps future tool calls match this workspace'),
		}),
	])
	.describe('Where to save the document. Prefer mode: "existing" matched by theme; only use "new" for clearly distinct topics.');

const boundSchema = z.object(baseShape);
const scopeFreeSchema = z.object({ ...baseShape, workspace: workspaceDecisionSchema });

type CreateInput = z.output<typeof boundSchema> | z.output<typeof scopeFreeSchema>;

export type CreateDocumentResult = {
	documentId: string;
	workspaceId: string;
	workspaceTitle: string;
	workspaceCreated: boolean;
	url: string;
};

const WRITER_SYSTEM_BASE =
	'You are an expert writer. Write high-quality, well-structured articles with clear headings, ' +
	'smooth transitions, and engaging prose. Adapt tone and depth to match the topic.';

function buildWriterSystem(language: 'zh' | 'en'): string {
	return `${WRITER_SYSTEM_BASE}\n\n${getOutputLanguageInstruction(language)}`;
}

function buildWritingPrompt(title: string, prompt: string): string {
	return [
		`Write a complete article titled "${title}".`,
		'',
		'## Instructions',
		prompt,
		'',
		'## Format',
		'- Markdown, starting with body text (no H1 title — it is stored separately)',
		'- Use ## (H2) as the highest heading level',
	].join('\n');
}

const BOUND_DESCRIPTION =
	'Create and save a new document with AI-generated content into the current workspace. ' +
	'Only use when the user explicitly asks to create/write/save a document. ' +
	'After creation, use add-resource to attach source articles.';

const SCOPE_FREE_DESCRIPTION =
	'Create and save a new document with AI-generated content. ' +
	'You must choose a workspace via the `workspace` field — match an existing one from the Workspace Catalog by theme, ' +
	'or create a new workspace only when the topic is clearly distinct. ' +
	'Only use when the user explicitly asks to create/write/save a document. ' +
	'After creation, use add-resource to attach source articles.';

export function createDocumentTool(ctx: Pick<ToolContext, 'env' | 'userId' | 'workspaceId' | 'planId' | 'streamWriter' | 'language'>) {
	const { env, userId, workspaceId: ctxWorkspaceId, planId, streamWriter: writer, language = 'zh' } = ctx;
	const bound = !!ctxWorkspaceId;

	return tool({
		description: bound ? BOUND_DESCRIPTION : SCOPE_FREE_DESCRIPTION,
		inputSchema: bound ? boundSchema : scopeFreeSchema,
		execute: async (input: CreateInput): Promise<CreateDocumentResult> => {
			const plan = await resolveWorkspacePlan(env, { ctxWorkspaceId, userId, planId, input });
			return runCreate({ env, input, plan, userId, language, writer });
		},
	});
}

async function resolveWorkspacePlan(
	env: Env,
	args: { ctxWorkspaceId: string | null; userId: string; planId: string; input: CreateInput },
): Promise<WorkspacePlanForDoc> {
	const { ctxWorkspaceId, userId, planId, input } = args;
	if (ctxWorkspaceId) {
		const workspace = await resolveExistingWorkspaceForDoc(env, { userId, workspaceId: ctxWorkspaceId });
		return { kind: 'existing', workspace };
	}
	const decision = (input as z.output<typeof scopeFreeSchema>).workspace;
	if (decision.mode === 'existing') {
		return {
			kind: 'existing',
			workspace: await resolveExistingWorkspaceForDoc(env, { userId, workspaceId: decision.workspaceId }),
		};
	}
	return {
		kind: 'new',
		pending: await validateNewWorkspaceForDoc(env, {
			userId,
			planId,
			title: decision.title,
			description: decision.description,
		}),
	};
}

interface RunCreateInput {
	env: Env;
	input: { title: string; prompt: string };
	plan: WorkspacePlanForDoc;
	userId: string;
	language: 'zh' | 'en';
	writer?: DataPartWriter;
}

async function runCreate({ env, input, plan, userId, language, writer }: RunCreateInput): Promise<CreateDocumentResult> {
	const { title, prompt } = input;
	const model = DEFAULT_CHAT_MODEL;
	const writingPrompt = buildWritingPrompt(title, prompt);

	// Gate on the estimated text cost before burning the paid generation —
	// mirrors generate-image's pre-check. Throws QuotaExceededError, surfaced to
	// the model as a tool error so it can tell the user to upgrade. Gated before
	// the `generating` status so a quota failure doesn't flash a false start.
	await billing.checkText(env, userId, model, writingPrompt);

	const workspaceCreated = plan.kind === 'new';
	const provisionalId = plan.kind === 'existing' ? plan.workspace.id : undefined;
	const provisionalTitle = plan.kind === 'existing' ? plan.workspace.title : plan.pending.title;

	const writeStatus = (status: 'generating' | 'saving' | 'complete', extras?: Record<string, unknown>) =>
		writer?.write({
			type: 'data-document-status',
			data: {
				status,
				title,
				...(provisionalId && { workspaceId: provisionalId }),
				workspaceTitle: provisionalTitle,
				...extras,
			},
			transient: true,
		});

	writeStatus('generating');

	const result = streamText({
		model: getModel(env, model),
		prompt: writingPrompt,
		system: buildWriterSystem(language),
		maxOutputTokens: 8000,
	});

	let content = '';
	if (writer) {
		for await (const chunk of result.textStream) {
			content += chunk;
			writer.write({ type: 'data-document-content', data: { chunk }, transient: true });
		}
		writeStatus('saving');
	} else {
		content = await result.text;
	}

	const usage = await result.usage;
	if (!content.trim()) throw new Error('Generated document content is empty');

	const lexical = markdownToLexicalJson(content);

	const { target, document } = await withTx(env, async (client) => {
		const ws = plan.kind === 'existing' ? plan.workspace : await commitNewWorkspaceForDoc(client, plan.pending);
		const docResult = await client.query<{ id: string }>(
			`INSERT INTO user_documents (user_id, workspace_id, title, content, creation_mode, version)
			 VALUES ($1, $2, $3, $4::jsonb, 'generate', 1)
			 RETURNING id`,
			[userId, ws.id, title, JSON.stringify(lexical)],
		);
		// A fresh `INSERT INTO workspaces` already stamps updated_at; only the
		// "saving into existing workspace" path needs the bump. Keeping this
		// inside the tx avoids opening a second pg client just to touch one row.
		if (plan.kind === 'existing') {
			await client.query(`UPDATE workspaces SET updated_at = NOW() WHERE id = $1`, [ws.id]);
		}
		const docRow = docResult.rows[0];
		if (!docRow) throw new Error('Failed to insert document');
		return { target: ws, document: docRow };
	});

	// Bill the internal generation's tokens server-side (atomic deduct + Polar),
	// instead of emitting a transient part for the client to self-report.
	// `trackText` never throws — a failed deduction is logged, not surfaced.
	if (usage?.inputTokens != null && usage?.outputTokens != null) {
		await billing.trackText(env, {
			userId,
			model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			meta: { endpoint: 'tool/create-document', documentId: document.id },
		});
	}

	writeStatus('complete', {
		documentId: document.id,
		workspaceId: target.id,
		workspaceTitle: target.title,
		workspaceCreated,
	});

	return {
		documentId: document.id,
		workspaceId: target.id,
		workspaceTitle: target.title,
		workspaceCreated,
		url: documentPath({ docId: document.id, workspaceId: target.id }),
	};
}
