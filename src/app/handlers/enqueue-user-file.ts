import { createDbClient, USER_FILES_TABLE } from '../../infra/db';
import { logInfo } from '../../infra/log';
import type { Env } from '../../models/types';
import { parseJsonBody, requireAuth } from '../middleware/auth';
import { createUserFileWorkflow } from '../workflows/article-workflow-client';

/**
 * Kick off the AI enrichment workflow for an existing `user_files` blob row
 * (currently only uploaded PDFs — images have no text to analyze). The
 * frontend writes the row during upload, then calls this endpoint to start
 * PDF extraction + analysis in the background. Idempotent — re-enqueue is
 * safe since the workflow skips extraction when `extracted_text` is set.
 */

type EnqueueBody = {
	userFileId?: string;
	userId?: string;
};

const SUPPORTED_FILE_TYPES = new Set(['application/pdf']);

export async function handleEnqueueUserFile(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const body = await parseJsonBody<EnqueueBody>(request);
	if (body instanceof Response) return body;

	if (!body.userFileId || !body.userId) {
		return Response.json(
			{ success: false, error: { code: 'BAD_REQUEST', message: 'userFileId and userId are required' } },
			{ status: 400 },
		);
	}

	const db = await createDbClient(env);
	let row: { user_id: string | null; resource_kind: string; origin_type: string; file_type: string } | undefined;
	try {
		const result = await db.query(`SELECT user_id, resource_kind, origin_type, file_type FROM ${USER_FILES_TABLE} WHERE id = $1 LIMIT 1`, [
			body.userFileId,
		]);
		row = result.rows[0];
	} finally {
		await db.end();
	}

	// 404 on not-found OR ownership mismatch — don't leak existence of other users' files.
	if (!row || row.user_id !== body.userId) {
		return Response.json({ success: false, error: { code: 'NOT_FOUND', message: 'user_file not found' } }, { status: 404 });
	}
	if (row.resource_kind !== 'blob' || row.origin_type !== 'upload') {
		return Response.json(
			{ success: false, error: { code: 'BAD_REQUEST', message: 'only uploaded blob rows are supported' } },
			{ status: 400 },
		);
	}
	if (!SUPPORTED_FILE_TYPES.has(row.file_type)) {
		return Response.json(
			{ success: false, error: { code: 'BAD_REQUEST', message: `file_type ${row.file_type} is not processable` } },
			{ status: 400 },
		);
	}

	const instanceId = await createUserFileWorkflow(env, body.userFileId, 'pdf');
	if (!instanceId) {
		return Response.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Workflow create failed' } }, { status: 500 });
	}

	logInfo('ENQUEUE_USER_FILE', 'Workflow created', { userFileId: body.userFileId, instanceId });
	return Response.json({ success: true, instanceId });
}
