import { parseJsonBody, requireAuth } from '@shared/auth';
import type { Env } from '@shared/types';

const DELETABLE_PREFIX = 'users/';
const R2_BATCH_LIMIT = 1000;

type DeleteMediaResult = { deleted: number; rejected: number };

function deleteSuccess(result: DeleteMediaResult): Response {
	return Response.json({ success: true, result });
}

function deleteFailure(message: string): Response {
	return Response.json({ success: false, error: { code: 'INTERNAL_ERROR', message } }, { status: 500 });
}

export async function handleDeleteAsset(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ storageKeys?: unknown }>(request);
	if (body instanceof Response) return body;

	const requested = Array.isArray(body.storageKeys) ? body.storageKeys : [];
	const keys = requested.filter((k): k is string => typeof k === 'string' && k.startsWith(DELETABLE_PREFIX));
	const rejected = requested.length - keys.length;

	if (keys.length === 0) return deleteSuccess({ deleted: 0, rejected });

	try {
		await deleteR2Objects(env, keys);
	} catch (err) {
		console.error({ tag: 'MEDIA_DELETE', msg: 'R2 batch delete failed', count: keys.length, error: String(err) });
		return deleteFailure('R2 delete failed');
	}

	return deleteSuccess({ deleted: keys.length, rejected });
}

async function deleteR2Objects(env: Env, keys: string[]): Promise<void> {
	for (let i = 0; i < keys.length; i += R2_BATCH_LIMIT) {
		await env.R2.delete(keys.slice(i, i + R2_BATCH_LIMIT));
	}
}
