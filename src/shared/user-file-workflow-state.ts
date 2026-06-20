import { USER_FILES_TABLE } from './article-store';
import { type DbClient, withDbClient } from './db';
import type { Env } from './types';

type UserFileWorkflowMetadataPatch = Record<string, string>;

async function patchUserFileWorkflowMetadata(db: DbClient, userFileId: string, patch: UserFileWorkflowMetadataPatch): Promise<void> {
	await db.query(
		`UPDATE ${USER_FILES_TABLE}
		 SET metadata = jsonb_set(
		   COALESCE(metadata, '{}'::jsonb),
		   '{workflow}',
		   COALESCE(metadata->'workflow', '{}'::jsonb) || $1::jsonb,
		   TRUE
		 )
		 WHERE id = $2`,
		[JSON.stringify(patch), userFileId],
	);
}

export async function getUserFileWorkflowInstanceId(env: Env, userFileId: string): Promise<string | null> {
	return withDbClient(env, async (db) => {
		const result = await db.query(
			`SELECT metadata->'workflow'->>'monitor_instance_id' AS instance_id FROM ${USER_FILES_TABLE} WHERE id = $1`,
			[userFileId],
		);
		const row = result.rows[0] as { instance_id?: string | null } | undefined;
		return row?.instance_id ?? null;
	});
}

export async function recordUserFileWorkflowInstanceId(env: Env, userFileId: string, instanceId: string): Promise<void> {
	await withDbClient(env, (db) =>
		patchUserFileWorkflowMetadata(db, userFileId, {
			monitor_instance_id: instanceId,
			monitor_status: 'running',
			monitor_started_at: new Date().toISOString(),
		}),
	);
}

export async function recordUserFileWorkflowComplete(db: DbClient, userFileId: string, articleId: string): Promise<void> {
	await patchUserFileWorkflowMetadata(db, userFileId, {
		monitor_status: 'complete',
		monitor_completed_at: new Date().toISOString(),
		article_id: articleId,
	});
}

export async function recordUserFileWorkflowFailed(env: Env, userFileId: string, error: string): Promise<void> {
	await withDbClient(env, (db) =>
		patchUserFileWorkflowMetadata(db, userFileId, {
			monitor_status: 'failed',
			monitor_failed_at: new Date().toISOString(),
			error: error.slice(0, 500),
		}),
	);
}
