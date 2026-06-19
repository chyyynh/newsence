import { createDbClient, type InsertBlobUserFileData, insertBlobUserFile } from '@shared/db';
import type { Env } from '@shared/types';
import { assertBlobUploadQuotaTx, UploadQuotaExceededError } from '@shared/upload';

/** Served upload assets are per-user-private and content-addressed by UUID key, so cache hard + privately. */
const UPLOAD_CACHE_CONTROL = 'private, max-age=31536000';

/**
 * Write an upload object to R2 with the standard upload cache headers. Throws on
 * failure (R2 never commits a partial object) — callers map the error to their
 * own outcome code, since the failure modes differ per path.
 */
export async function putUserUpload(
	env: Env,
	args: { storageKey: string; body: ReadableStream<Uint8Array>; contentType: string },
): Promise<void> {
	await env.R2.put(args.storageKey, args.body, {
		httpMetadata: { contentType: args.contentType, cacheControl: UPLOAD_CACHE_CONTROL },
	});
}

export type PersistBlobResult =
	| { ok: true; userFileId: string }
	| { ok: false; code: 'QUOTA_EXCEEDED' | 'INTERNAL_ERROR'; message: string };

/**
 * Commit a blob's `user_files` row inside a quota-guarded transaction, deleting
 * the already-staged R2 object (`data.storageKey`) if the transaction can't
 * commit. The caller must have written that object via `putUserUpload` first.
 */
export async function persistBlobRow(env: Env, data: InsertBlobUserFileData): Promise<PersistBlobResult> {
	const db = await createDbClient(env);
	try {
		// Quota + insert share one transaction so the advisory lock in
		// assertBlobUploadQuotaTx serializes a user's concurrent saves and they
		// can't race past the cap. The worker is the authoritative enforcer; the
		// frontend's pre-check is best-effort UX only.
		await db.query('BEGIN');
		await assertBlobUploadQuotaTx(db, data.userId, data.fileSize);
		const row = await insertBlobUserFile(db, data);
		await db.query('COMMIT');
		return { ok: true, userFileId: row.id };
	} catch (err) {
		await db
			.query('ROLLBACK')
			.catch((rollbackErr) =>
				console.error({ tag: 'PERSIST_BLOB', msg: 'rollback failed', storageKey: data.storageKey, error: String(rollbackErr) }),
			);
		console.error({ tag: 'PERSIST_BLOB', msg: 'blob row insert failed', storageKey: data.storageKey, error: String(err) });
		// Compensate: drop the R2 object the caller staged. delete is strongly
		// consistent + idempotent — best-effort, log if it also fails.
		await env.R2.delete(data.storageKey).catch((delErr) =>
			console.error({
				tag: 'PERSIST_BLOB',
				msg: 'R2 cleanup after DB failure also failed',
				storageKey: data.storageKey,
				error: String(delErr),
			}),
		);
		if (err instanceof UploadQuotaExceededError) {
			return { ok: false, code: 'QUOTA_EXCEEDED', message: err.message };
		}
		return { ok: false, code: 'INTERNAL_ERROR', message: 'DB insert failed' };
	} finally {
		await db.end();
	}
}
