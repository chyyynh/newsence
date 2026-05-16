import type { DbClient } from './db';

const FREE_MAX_USER_FILE_STORAGE_BYTES = 100 * 1024 * 1024;
const FREE_MAX_USER_FILES = 50;
const UNLIMITED_UPLOAD_PLANS = new Set(['pro', 'test']);

type BlobUploadQuota = {
	maxUserFileStorageBytes: number | null;
	maxUserFiles: number | null;
};

export class UploadQuotaExceededError extends Error {
	constructor(
		message: string,
		readonly details: Record<string, unknown>,
	) {
		super(message);
		this.name = 'UploadQuotaExceededError';
	}
}

function getBlobUploadQuota(planId: string): BlobUploadQuota {
	if (UNLIMITED_UPLOAD_PLANS.has(planId)) {
		return { maxUserFileStorageBytes: null, maxUserFiles: null };
	}
	return {
		maxUserFileStorageBytes: FREE_MAX_USER_FILE_STORAGE_BYTES,
		maxUserFiles: FREE_MAX_USER_FILES,
	};
}

/**
 * Must be called inside the same explicit transaction as the blob row insert.
 * The transaction-scoped advisory lock serializes concurrent blob inserts for
 * one user so a URL batch cannot race itself past the quota check.
 */
export async function assertBlobUploadQuotaTx(db: DbClient, userId: string, incomingBytes: number): Promise<void> {
	await db.query('SELECT pg_advisory_xact_lock(752617, hashtext($1))', [userId]);

	const settings = await db.query<{ plan_id: string }>('SELECT plan_id FROM user_settings WHERE user_id = $1 LIMIT 1', [userId]);
	const planId = settings.rows[0]?.plan_id ?? 'free';
	const { maxUserFileStorageBytes, maxUserFiles } = getBlobUploadQuota(planId);
	if (maxUserFileStorageBytes === null && maxUserFiles === null) return;

	const usage = await db.query<{ total_bytes: string | null; total_files: string }>(
		`SELECT COALESCE(SUM(file_size), 0)::text AS total_bytes, COUNT(*)::text AS total_files
		 FROM user_files
		 WHERE user_id = $1
		   AND resource_kind = 'blob'`,
		[userId],
	);
	const currentBytes = Number.parseInt(usage.rows[0]?.total_bytes ?? '0', 10);
	const currentFiles = Number.parseInt(usage.rows[0]?.total_files ?? '0', 10);

	if (maxUserFiles !== null && currentFiles >= maxUserFiles) {
		throw new UploadQuotaExceededError('Upload file quota exceeded', {
			limit: maxUserFiles,
			used: currentFiles,
			planId,
		});
	}

	if (maxUserFileStorageBytes !== null && currentBytes + incomingBytes > maxUserFileStorageBytes) {
		throw new UploadQuotaExceededError('Upload storage quota exceeded', {
			limit: maxUserFileStorageBytes,
			used: currentBytes,
			incoming: incomingBytes,
			planId,
		});
	}
}
