// MIRROR OF frontend/src/lib/workspace/aiContext.ts, rewritten from Prisma to
// raw pg (the worker chat surface is raw-pg for tool/context tables — see #136
// re-decision). Keep the output format aligned with the frontend so a
// workspace-scoped chat reads the same context on either surface.
//
// Used by the chat handler only when `scope.kind === 'workspace'`; document
// scope skips the summary because the document itself flows through
// `contextItems`.

import type { Env } from '../../models/types';
import { withClient } from '../db/client';

const MAX_CITATIONS = 200;
const MAX_ARTICLES = 20;

interface CitationRow {
	to_type: string;
	to_id: string;
}

/**
 * Summary of a workspace's citations for AI context injection. Limited to
 * counts + lightweight identifiers — the chat route can hydrate full content
 * via its own retrieval layer if the model asks for it. Returns null when the
 * workspace is missing or not owned by the user.
 */
export async function getWorkspaceContextSummary(env: Env, workspaceId: string, userId: string): Promise<string | null> {
	return withClient(env, async (client) => {
		const workspace = await client.query<{ title: string }>(`SELECT title FROM workspaces WHERE id = $1 AND user_id = $2 LIMIT 1`, [
			workspaceId,
			userId,
		]);
		const title = workspace.rows[0]?.title;
		if (title === undefined) return null;

		const citations = await client.query<CitationRow>(
			`SELECT to_type, to_id FROM citations
			 WHERE from_type = 'workspace' AND from_id = $1 AND user_id = $2
			 LIMIT $3`,
			[workspaceId, userId, MAX_CITATIONS],
		);
		if (citations.rows.length === 0) {
			return `Workspace: ${title}. No pinned resources.`;
		}

		const collectionIds = citations.rows.filter((c) => c.to_type === 'collection').map((c) => c.to_id);
		const articleIds = citations.rows.filter((c) => c.to_type === 'article').map((c) => c.to_id);

		const collections = collectionIds.length
			? (await client.query<{ id: string; name: string }>(`SELECT id, name FROM collections WHERE id = ANY($1::uuid[])`, [collectionIds]))
					.rows
			: [];
		const articles = articleIds.length
			? (
					await client.query<{ id: string; title: string; source: string | null; published_date: Date | string | null }>(
						`SELECT id, title, source, published_date FROM articles
						 WHERE id = ANY($1::uuid[])
						 ORDER BY published_date DESC NULLS LAST
						 LIMIT $2`,
						[articleIds, MAX_ARTICLES],
					)
				).rows
			: [];

		const lines = [
			`Workspace: ${title}`,
			`Cited collections (${collections.length}):`,
			...collections.map((c) => `- [${c.id}] ${c.name}`),
			`Pinned articles (${articles.length}):`,
			...articles.map((a) => `- [${a.id}] ${a.title} — ${a.source ?? 'article'} (${formatDate(a.published_date)})`),
		];
		return lines.join('\n');
	});
}

function formatDate(value: Date | string | null): string {
	if (!value) return 'undated';
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? 'undated' : d.toISOString().slice(0, 10);
}
