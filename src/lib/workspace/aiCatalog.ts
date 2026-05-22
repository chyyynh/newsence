// Mirrors frontend/src/lib/workspace/aiCatalog.ts. `commitNewWorkspaceForDoc`
// takes a caller-supplied pg client so the workspace insert can land in the
// same transaction as the doc insert (matches the Vercel `$transaction`).
//
// Quota-check race (TOCTOU): two parallel create-document calls at the free
// plan's limit can both see `count < max` and both insert, landing the user
// at `max + 1`. Acceptable for now (workspace creation is rare and a single
// over-cap workspace isn't load-bearing); revisit with an advisory lock or
// `INSERT ... WHERE (SELECT COUNT(*) ...) < $max` if abuse appears.

import type { Client } from 'pg';
import type { Env } from '../../models/types';
import { getPlanQuotas } from '../billing/plans';
import { withClient } from '../db/client';

const MAX_CATALOG_ENTRIES = 20;

export interface WorkspaceCatalogEntry {
	id: string;
	title: string;
	description: string | null;
	documentCount: number;
	lastActiveAt: Date;
}

export async function listWorkspacesForAI(env: Env, userId: string): Promise<WorkspaceCatalogEntry[]> {
	return withClient(env, async (client) => {
		const result = await client.query<{
			id: string;
			title: string;
			description: string | null;
			updated_at: Date | string;
			document_count: string | number;
		}>(
			`SELECT w.id, w.title, w.description, w.updated_at,
			        COUNT(d.id)::int AS document_count
			 FROM workspaces w
			 LEFT JOIN user_documents d ON d.workspace_id = w.id
			 WHERE w.user_id = $1
			 GROUP BY w.id
			 ORDER BY w.updated_at DESC
			 LIMIT $2`,
			[userId, MAX_CATALOG_ENTRIES],
		);
		return result.rows.map((r) => ({
			id: r.id,
			title: r.title,
			description: r.description,
			documentCount: Number(r.document_count),
			lastActiveAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at),
		}));
	});
}

interface CatalogPromptInput {
	entries: WorkspaceCatalogEntry[];
	planId: string;
}

export function buildWorkspaceCatalogPrompt({ entries, planId }: CatalogPromptInput): string {
	const { maxWorkspaces } = getPlanQuotas(planId);
	const atQuota = maxWorkspaces !== null && entries.length >= maxWorkspaces;
	const quotaLine =
		maxWorkspaces === null
			? `Plan: unlimited workspaces.`
			: atQuota
				? `Plan limit reached: ${entries.length}/${maxWorkspaces} workspaces. You MUST pick an existing one — creating a new workspace will fail.`
				: `Plan limit: ${entries.length}/${maxWorkspaces} workspaces.`;

	if (entries.length === 0) {
		return [
			'# Workspace Catalog',
			'The user has no workspaces yet. When calling `create-document`, you MUST use `workspace.mode: "new"`.',
			quotaLine,
		].join('\n');
	}

	const lines = entries.map((e) => {
		const desc = e.description?.trim() ? ` — ${e.description.trim()}` : '';
		return `- [${e.id}] "${e.title}"${desc} (${e.documentCount} docs)`;
	});

	return [
		'# Workspace Catalog',
		'When calling `create-document`, decide where the document fits:',
		'- Match an existing workspace by theme/topic → `workspace.mode: "existing"` with that `workspaceId`.',
		'- Create a new workspace ONLY when the topic is clearly distinct from every existing workspace.',
		'Strongly prefer existing matches. Workspaces are long-term organizational units; do not create one per chat.',
		'',
		quotaLine,
		'',
		'Existing workspaces (most recently updated first):',
		...lines,
	].join('\n');
}

export interface ResolvedWorkspaceForDoc {
	id: string;
	title: string;
}

export interface NewWorkspacePlan {
	userId: string;
	title: string;
	description?: string;
}

export type WorkspacePlanForDoc = { kind: 'existing'; workspace: ResolvedWorkspaceForDoc } | { kind: 'new'; pending: NewWorkspacePlan };

export async function resolveExistingWorkspaceForDoc(
	env: Env,
	{ userId, workspaceId }: { userId: string; workspaceId: string },
): Promise<ResolvedWorkspaceForDoc> {
	const row = await withClient(env, async (client) => {
		const result = await client.query<{ id: string; title: string }>(
			`SELECT id, title FROM workspaces WHERE id = $1 AND user_id = $2 LIMIT 1`,
			[workspaceId, userId],
		);
		return result.rows[0] ?? null;
	});
	if (!row) {
		throw new Error(`Workspace ${workspaceId} not found in the user's catalog. Pick an id from the catalog or use mode: "new".`);
	}
	return { id: row.id, title: row.title };
}

export async function validateNewWorkspaceForDoc(
	env: Env,
	{ userId, planId, title, description }: { userId: string; planId: string; title: string; description?: string },
): Promise<NewWorkspacePlan> {
	const trimmedTitle = title.trim();
	if (!trimmedTitle) throw new Error('New workspace title cannot be empty.');

	const { maxWorkspaces } = getPlanQuotas(planId);
	if (maxWorkspaces !== null) {
		const count = await withClient(env, async (client) => {
			const result = await client.query<{ c: string | number }>(`SELECT COUNT(*)::int AS c FROM workspaces WHERE user_id = $1`, [userId]);
			return Number(result.rows[0]?.c ?? 0);
		});
		if (count >= maxWorkspaces) {
			throw new Error(
				`Workspace quota exceeded (${count}/${maxWorkspaces}). Pick an existing workspace from the catalog instead of creating a new one.`,
			);
		}
	}

	return {
		userId,
		title: trimmedTitle.slice(0, 120),
		...(description?.trim() && { description: description.trim().slice(0, 500) }),
	};
}

export async function commitNewWorkspaceForDoc(client: Client, plan: NewWorkspacePlan): Promise<ResolvedWorkspaceForDoc> {
	const result = await client.query<{ id: string; title: string }>(
		`INSERT INTO workspaces (user_id, title, description)
		 VALUES ($1, $2, $3)
		 RETURNING id, title`,
		[plan.userId, plan.title, plan.description ?? null],
	);
	const row = result.rows[0];
	if (!row) throw new Error('Failed to create workspace');
	return { id: row.id, title: row.title };
}
