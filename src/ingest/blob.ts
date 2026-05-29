import { storageKeyToAssetUrl } from '@shared/asset-url';
import { createDbClient, insertBlobUserFile } from '@shared/db/articles';
import { logError, logInfo } from '@shared/log';
import { extensionFromMime, isRasterImage } from '@shared/mime';
import type { Env } from '@shared/types';
import { createUserFileWorkflow } from './workflows/article-workflow-client';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const PDF_MIME = 'application/pdf';

export type IngestBlobErrorCode = 'BAD_REQUEST' | 'RATE_LIMITED' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_ERROR';

export interface BlobIngestResult {
	userFileId: string;
	storageKey: string;
	assetUrl: string;
	fileType: string;
	fileSize: number;
	title: string | null;
	originType: 'upload';
	instanceId?: string;
}

export type IngestBlobOutcome = { ok: true; result: BlobIngestResult } | { ok: false; code: IngestBlobErrorCode; message: string };

function sanitizeTitle(fileName: string, fileType: string): string {
	const stripped = fileType === PDF_MIME ? fileName.replace(/\.pdf$/i, '') : fileName;
	return stripped || fileName;
}

function buildPdfMetadata(args: { fileName: string; fileSize: number; storageKey: string }) {
	return {
		type: 'pdf' as const,
		fetchedAt: new Date().toISOString(),
		data: {
			fileName: args.fileName,
			fileSize: args.fileSize,
			pdfUrl: storageKeyToAssetUrl(args.storageKey),
		},
	};
}

export async function ingestBlob(request: Request, env: Env): Promise<IngestBlobOutcome> {
	let form: FormData;
	try {
		form = await request.formData();
	} catch (err) {
		return { ok: false, code: 'BAD_REQUEST', message: `Invalid multipart body: ${err}` };
	}

	const file = form.get('file');
	const userId = (form.get('userId') as string | null)?.trim() || '';
	const titleOverride = (form.get('title') as string | null)?.trim() || null;

	if (!(file instanceof File)) {
		return { ok: false, code: 'BAD_REQUEST', message: 'Missing file part' };
	}
	if (!userId) {
		return { ok: false, code: 'BAD_REQUEST', message: 'Missing userId form field' };
	}

	// Per-user throttle, mirroring the JSON ingest paths — without this the
	// multipart upload surface was the one unmetered entry point on /ingest.
	const { success } = await env.USER_INGEST_LIMITER.limit({ key: `user:${userId}` });
	if (!success) {
		return { ok: false, code: 'RATE_LIMITED', message: 'Too many ingest requests; retry shortly.' };
	}

	if (file.size === 0) {
		return { ok: false, code: 'BAD_REQUEST', message: 'Empty file' };
	}
	if (file.size > MAX_FILE_BYTES) {
		return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds 10MB' };
	}

	const fileType = file.type || 'application/octet-stream';
	if (fileType !== PDF_MIME && !isRasterImage(fileType)) {
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported file type: ${fileType}` };
	}

	const extension = extensionFromMime(fileType, file.name);
	const storageKey = `users/${userId}/uploads/${crypto.randomUUID()}.${extension}`;

	try {
		await env.R2.put(storageKey, file.stream(), {
			httpMetadata: { contentType: fileType, cacheControl: 'private, max-age=31536000' },
		});
	} catch (err) {
		logError('INGEST_BLOB', 'R2 put failed', { storageKey, error: String(err) });
		return { ok: false, code: 'INTERNAL_ERROR', message: 'R2 put failed' };
	}

	const title = titleOverride ?? sanitizeTitle(file.name, fileType);
	const metadata = fileType === PDF_MIME ? buildPdfMetadata({ fileName: file.name, fileSize: file.size, storageKey }) : null;

	const db = await createDbClient(env);
	let userFileId: string;
	try {
		const row = await insertBlobUserFile(db, {
			userId,
			storageKey,
			fileSize: file.size,
			fileType,
			fileName: file.name,
			originType: 'upload',
			title,
			metadata,
		});
		userFileId = row.id;
	} catch (err) {
		logError('INGEST_BLOB', 'DB insert failed', { storageKey, error: String(err) });
		// Compensate: drop the R2 blob we just wrote. delete is strongly consistent
		// + idempotent — best-effort, log if it also fails.
		await env.R2.delete(storageKey).catch((delErr) =>
			logError('INGEST_BLOB', 'R2 cleanup after DB failure also failed', { storageKey, error: String(delErr) }),
		);
		return { ok: false, code: 'INTERNAL_ERROR', message: 'DB insert failed' };
	} finally {
		await db.end();
	}

	// Only PDFs trigger the AI workflow today — images have no text to analyze.
	let instanceId: string | undefined;
	if (fileType === PDF_MIME) {
		instanceId = await createUserFileWorkflow(env, userFileId, 'pdf');
	}

	logInfo('INGEST_BLOB', 'Stored blob', { userFileId, storageKey, fileType, fileSize: file.size });

	return {
		ok: true,
		result: {
			userFileId,
			storageKey,
			assetUrl: storageKeyToAssetUrl(storageKey),
			fileType,
			fileSize: file.size,
			title,
			originType: 'upload',
			instanceId,
		},
	};
}
