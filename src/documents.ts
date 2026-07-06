import type { DbClient } from '@shared/db';
import { withDbClient } from '@shared/db';
import type { Env } from '@shared/types';
import { canCreateWorkspaceForPlan } from '@worker-contracts/billing-contracts';
import type { WorkspaceCatalogResult, WorkspaceCreationCapability } from '@worker-contracts/core-rpc';

type WorkspaceCapabilityRow = { plan_id: string | null; workspace_count: string | number };
type WorkspaceCatalogRow = WorkspaceCapabilityRow & {
	id: string | null;
	title: string | null;
	description: string | null;
	document_count: string | number | null;
};

async function readWorkspaceCreationCapability(db: DbClient, userId: string): Promise<WorkspaceCreationCapability> {
	const meta = (
		await db.query<WorkspaceCapabilityRow>(
			`SELECT
			   (SELECT plan_id FROM user_settings WHERE user_id = $1 LIMIT 1) AS plan_id,
			   COUNT(*) AS workspace_count
			 FROM workspaces
			 WHERE user_id = $1`,
			[userId],
		)
	).rows[0];
	return workspaceCreationCapabilityFromRow(meta);
}

function workspaceCreationCapabilityFromRow(row: WorkspaceCapabilityRow | undefined): WorkspaceCreationCapability {
	return {
		canCreateWorkspace: canCreateWorkspaceForPlan(row?.plan_id ?? 'free', Number(row?.workspace_count ?? 0)),
	};
}

export async function workspaceCreationCapability(env: Env, userId: string): Promise<WorkspaceCreationCapability> {
	return withDbClient(env, (db) => readWorkspaceCreationCapability(db, userId));
}

export async function listWorkspaces(env: Env, userId: string): Promise<WorkspaceCatalogResult> {
	return withDbClient(env, async (db) => {
		const result = await db.query<WorkspaceCatalogRow>(
			`WITH meta AS (
				 SELECT
				   (SELECT plan_id FROM user_settings WHERE user_id = $1 LIMIT 1) AS plan_id,
				   (SELECT COUNT(*) FROM workspaces WHERE user_id = $1) AS workspace_count
			   ),
			   catalog AS (
				 SELECT w.id, w.title, w.description, w.updated_at, COUNT(d.id) AS document_count
				 FROM workspaces w
				 LEFT JOIN user_documents d ON d.workspace_id = w.id AND d.user_id = w.user_id
				 WHERE w.user_id = $1
				 GROUP BY w.id
				 ORDER BY w.updated_at DESC
				 LIMIT 50
			   )
			 SELECT meta.plan_id, meta.workspace_count, catalog.id, catalog.title, catalog.description, catalog.document_count
			 FROM meta
			 LEFT JOIN catalog ON true
			 ORDER BY catalog.updated_at DESC NULLS LAST`,
			[userId],
		);
		const capability = workspaceCreationCapabilityFromRow(result.rows[0]);
		return {
			canCreateWorkspace: capability.canCreateWorkspace,
			entries: result.rows
				.filter(
					(row): row is WorkspaceCatalogRow & { id: string; title: string; document_count: string | number } =>
						typeof row.id === 'string' && typeof row.title === 'string' && row.document_count != null,
				)
				.map((row) => ({
					id: row.id,
					title: row.title,
					description: row.description,
					documentCount: Number(row.document_count),
				})),
		};
	});
}
