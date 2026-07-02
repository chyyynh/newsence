import { jsonData, jsonError, parseJsonBody, requireAuth } from '@shared/auth';
import { withDbClient, withDbTransaction } from '@shared/db';
import type { Env } from '@shared/types';
import { storageKeyToAssetUrl } from '@shared/upload';
import type { DeleteUserMediaFileResult } from '@worker-contracts/core-rpc';

const DELETABLE_PREFIX = 'users/';
const R2_BATCH_LIMIT = 1000;
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DeleteMediaResult = { deleted: number; rejected: number };
type UserFileRow = { id: string; storage_key: string | null };
type DocumentContentRow = { title: string; content: unknown };

function contentReferencesMediaAsset(node: unknown, assetUrl: string): boolean {
	if (Array.isArray(node)) return node.some((child) => contentReferencesMediaAsset(child, assetUrl));
	if (!node || typeof node !== 'object') return false;
	for (const [key, value] of Object.entries(node)) {
		if (key === 'src' && value === assetUrl) return true;
		if (contentReferencesMediaAsset(value, assetUrl)) return true;
	}
	return false;
}

async function assertMediaFileNotUsedInDocuments(env: Env, userId: string, storageKey: string): Promise<void> {
	const assetUrl = storageKeyToAssetUrl(storageKey);
	const hit = await withDbClient(env, async (db) => {
		const documents = await db.query<DocumentContentRow>(`SELECT title, content FROM user_documents WHERE user_id = $1`, [userId]);
		return documents.rows.find((document) => contentReferencesMediaAsset(document.content, assetUrl));
	});
	if (hit) {
		throw new Error(`This image is used in "${hit.title || 'Untitled'}". Remove it from the document before deleting it.`);
	}
}

export async function deleteUserMediaFile(env: Env, input: { userId: string; fileId: string }): Promise<DeleteUserMediaFileResult> {
	if (!UUID_FORMAT.test(input.fileId)) throw new Error('File not found');
	const file = await withDbClient(env, async (db) => {
		return (
			await db.query<UserFileRow>(
				`SELECT id, storage_key FROM user_files WHERE id = $1 AND user_id = $2 AND resource_kind = 'blob' LIMIT 1`,
				[input.fileId, input.userId],
			)
		).rows[0];
	});
	if (!file) throw new Error('File not found');

	if (file.storage_key) {
		await assertMediaFileNotUsedInDocuments(env, input.userId, file.storage_key);
	}

	await withDbTransaction(env, 'delete user media file', async (db) => {
		await db.query(`DELETE FROM citations WHERE user_id = $1 AND to_type = 'user_file' AND to_id = $2`, [input.userId, file.id]);
		await db.query(`DELETE FROM user_files WHERE id = $1 AND user_id = $2 AND resource_kind = 'blob'`, [file.id, input.userId]);
	});

	// R2 last: failing here only orphans a blob, never a live row pointing at a deleted object.
	if (file.storage_key) {
		try {
			await deleteR2Objects(env, [file.storage_key]);
		} catch (error) {
			console.error({ tag: 'MEDIA_DELETE', msg: 'R2 delete failed after row removal', key: file.storage_key, error: String(error) });
		}
	}

	return { ok: true, id: file.id };
}

export async function handleDeleteUserMediaFile(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ userId?: string; fileId?: string }>(request);
	if (body instanceof Response) return body;
	if (!body.userId?.trim() || !body.fileId?.trim()) return jsonError('BAD_REQUEST', 'Missing userId or fileId', 400);

	try {
		const result = await deleteUserMediaFile(env, { userId: body.userId, fileId: body.fileId });
		return jsonData(result);
	} catch (error) {
		if (error instanceof Error && error.message === 'File not found') return jsonError('NOT_FOUND', error.message, 404);
		if (error instanceof Error && error.message.startsWith('This image is used in ')) {
			return jsonError('MEDIA_IN_USE', error.message, 409);
		}
		console.error({ tag: 'MEDIA_DELETE', msg: 'user media delete failed', error: String(error) });
		return jsonError('INTERNAL_ERROR', 'Media delete failed', 500);
	}
}

export async function handleDeleteAsset(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ storageKeys?: unknown }>(request);
	if (body instanceof Response) return body;

	const requested = Array.isArray(body.storageKeys) ? body.storageKeys : [];
	const keys = requested.filter((k): k is string => typeof k === 'string' && k.startsWith(DELETABLE_PREFIX));
	const rejected = requested.length - keys.length;

	if (keys.length === 0) return jsonData({ deleted: 0, rejected } satisfies DeleteMediaResult);

	try {
		await deleteR2Objects(env, keys);
	} catch (err) {
		console.error({ tag: 'MEDIA_DELETE', msg: 'R2 batch delete failed', count: keys.length, error: String(err) });
		return jsonError('INTERNAL_ERROR', 'R2 delete failed', 500);
	}

	return jsonData({ deleted: keys.length, rejected } satisfies DeleteMediaResult);
}

async function deleteR2Objects(env: Env, keys: string[]): Promise<void> {
	for (let i = 0; i < keys.length; i += R2_BATCH_LIMIT) {
		await env.R2.delete(keys.slice(i, i + R2_BATCH_LIMIT));
	}
}
