// Mirrors frontend/src/lib/ai/tools/add-resource.ts. Calls ingestUrls in
// the same isolate (no self-fetch to /ingest); ON CONFLICT DO NOTHING gives
// Prisma's skipDuplicates semantics on the citations insert.

import { ingestUrls } from '@ingest/urls';
import { withClient } from '@shared/db/client';
import { isValidUuid } from '@shared/ids';
import type { Env } from '@shared/types';
import { tool } from 'ai';
import { z } from 'zod';

export type AddResourceResult = {
	created: number;
	duplicates: number;
	missing: number;
	ingested?: number;
};

const addResourceSchema = z
	.object({
		documentId: z.string().describe('ID of the document (its workspace receives the citations)'),
		resourceIds: z
			.array(z.string())
			.max(20)
			.optional()
			.describe('Resource IDs to link (articles.id or user_files.id). For existing DB-backed resources.'),
		urls: z
			.array(z.string().url())
			.max(20)
			.optional()
			.describe(
				'External URLs to ingest and cite. Each URL is crawled and saved to the user library before linking. ' +
					'Pass ONLY URLs actually cited in the document body — unreferenced URLs become orphaned library entries.',
			),
	})
	.refine((v) => (v.resourceIds?.length ?? 0) + (v.urls?.length ?? 0) > 0, {
		message: 'Provide at least one of resourceIds or urls',
	});

async function ingestUrlsForUser(env: Env, urls: string[], userId: string): Promise<string[]> {
	if (urls.length === 0) return [];
	try {
		const outcome = await ingestUrls(env, { urls, userId });
		if (!outcome.ok) return [];
		return outcome.results.map((r) => r.userFileId).filter((id): id is string => !!id);
	} catch (err) {
		console.error('[add-resource] ingestUrls failed:', err);
		return [];
	}
}

export function createAddResourceTool(env: Env, userId: string) {
	return tool({
		description:
			"Pin resources (public articles, user files, or external URLs) to the document's workspace. " +
			'Use after create-document to attach sources you referenced. ' +
			'Pass `resourceIds` for existing DB resources, `urls` for external links — both can be used together.',
		inputSchema: addResourceSchema,
		execute: async ({ documentId, resourceIds, urls }): Promise<AddResourceResult> => {
			if (!isValidUuid(documentId)) throw new Error('Invalid documentId');

			const workspaceId = await withClient(env, async (client) => {
				const result = await client.query<{ workspace_id: string }>(
					`SELECT workspace_id FROM user_documents WHERE id = $1 AND user_id = $2 LIMIT 1`,
					[documentId, userId],
				);
				return result.rows[0]?.workspace_id ?? null;
			});
			if (!workspaceId) throw new Error('Document not found');

			const ingestedIds = urls?.length ? await ingestUrlsForUser(env, urls, userId) : [];
			const uniqueIds = [...new Set([...(resourceIds ?? []), ...ingestedIds])].filter(isValidUuid);
			if (uniqueIds.length === 0) {
				return { created: 0, duplicates: 0, missing: 0, ingested: ingestedIds.length };
			}

			return withClient(env, async (client) => {
				const [articlesResult, userFilesResult] = await Promise.all([
					client.query<{ id: string }>(`SELECT id FROM articles WHERE id = ANY($1::uuid[])`, [uniqueIds]),
					client.query<{ id: string }>(`SELECT id FROM user_files WHERE id = ANY($1::uuid[]) AND user_id = $2`, [uniqueIds, userId]),
				]);
				const articleIds = new Set(articlesResult.rows.map((a) => a.id));
				const userFileIds = new Set(userFilesResult.rows.map((f) => f.id));

				const targets = uniqueIds
					.map((id) => {
						if (articleIds.has(id)) return { toType: 'article' as const, toId: id };
						if (userFileIds.has(id)) return { toType: 'user_file' as const, toId: id };
						return null;
					})
					.filter((t): t is NonNullable<typeof t> => t !== null);
				const missing = uniqueIds.length - targets.length;

				if (targets.length === 0) {
					return { created: 0, duplicates: 0, missing, ingested: ingestedIds.length };
				}

				// Multi-row INSERT with ON CONFLICT to match Prisma's
				// `createMany({ skipDuplicates: true })`. The unique constraint
				// on citations is (from_type, from_id, to_type, to_id) — user_id
				// is NOT part of it, so leave user_id out of the conflict target
				// (per psql \d: citations_from_type_from_id_to_type_to_id_key).
				const params: unknown[] = [userId, 'workspace', workspaceId];
				const valueRows: string[] = [];
				for (const t of targets) {
					params.push(t.toType, t.toId);
					const i = params.length;
					valueRows.push(`($1, $2, $3, $${i - 1}, $${i})`);
				}
				const result = await client.query<{ id: string }>(
					`INSERT INTO citations (user_id, from_type, from_id, to_type, to_id)
					 VALUES ${valueRows.join(', ')}
					 ON CONFLICT (from_type, from_id, to_type, to_id) DO NOTHING
					 RETURNING id`,
					params,
				);
				const created = result.rows.length;
				return { created, duplicates: targets.length - created, missing, ingested: ingestedIds.length };
			});
		},
	});
}
