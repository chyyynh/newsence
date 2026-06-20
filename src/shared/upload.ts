import type { DbClient } from './db';
import { PDF_MIME } from './mime';
import { buildMetadata } from './platform-metadata';

// Single source of truth for the blob-ingest size cap. Every path that accepts a
// user file — multipart upload, URL→blob, external image URL, and the /scrape
// raw-bytes body — rejects above this. Keep them in lockstep by importing here
// rather than redeclaring the literal.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Filename → display title: drop the file extension (`report.pdf` → `report`,
// `vacation.jpg` → `vacation`). Shared by every blob-ingest path so the same
// file yields the same title however it arrived. Falls back to the raw name for
// degenerate inputs like `.pdf`.
export function deriveFileTitle(fileName: string): string {
	return fileName.replace(/\.[a-z0-9]{1,8}$/i, '') || fileName;
}

// Builds the `user_files.metadata` jsonb for a stored PDF, or null for any other
// type. Folding the PDF check in here keeps the "is this a PDF?" branch out of
// every caller. Shared by the multipart-upload and URL→blob paths. The fetch URL
// is intentionally NOT stored — it's derived from `storage_key` at read time
// (see frontend `getUserFileResourceUrl`), so a route rename can't rot the row.
export function buildPdfMetadata(args: { fileType: string; fileName: string; fileSize: number }) {
	if (args.fileType !== PDF_MIME) return null;
	return buildMetadata('pdf', {
		fileName: args.fileName,
		fileSize: args.fileSize,
	});
}

export function isExtractablePdfFile(args: { originType?: string | null; fileType?: string | null; storageKey?: string | null }): boolean {
	return (args.originType === 'upload' || args.originType === 'saved_url') && args.fileType === PDF_MIME && !!args.storageKey;
}

export function storageKeyToAssetUrl(key: string): string {
	return `/api/media/asset/${key}`;
}

export function userUploadKey(userId: string, extension: string): string {
	return `users/${userId}/uploads/${crypto.randomUUID()}.${extension}`;
}

export function userGeneratedImageKey(userId: string, extension: string): string {
	return `users/${userId}/illustrations/${crypto.randomUUID()}.${extension}`;
}

export class PayloadTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`Response body exceeded ${maxBytes} bytes`);
		this.name = 'PayloadTooLargeError';
	}
}

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

export function streamWithByteLimit(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): { stream: ReadableStream<Uint8Array>; getBytesSeen: () => number } {
	let bytesSeen = 0;
	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytesSeen += chunk.byteLength;
				if (bytesSeen > maxBytes) {
					controller.error(new PayloadTooLargeError(maxBytes));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return { stream, getBytesSeen: () => bytesSeen };
}
