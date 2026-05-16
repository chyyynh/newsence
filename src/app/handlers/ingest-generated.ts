/**
 * POST /ingest-generated — store an AI-generated image as a `user_files` row
 * (originType='generated'). Parallel to /ingest but lands under
 * `users/{userId}/illustrations/` so user-curated and machine-generated
 * assets stay visually separable in R2.
 */

import { createDbClient, insertBlobUserFile } from '../../infra/db';
import { logError, logInfo } from '../../infra/log';
import { extensionFromMime, isRasterImage } from '../../infra/mime';
import type { Env } from '../../models/types';
import { requireAuth } from '../middleware/auth';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function badRequest(message: string): Response {
	return Response.json({ success: false, error: { code: 'BAD_REQUEST', message } }, { status: 400 });
}

export async function handleIngestGenerated(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	let form: FormData;
	try {
		form = await request.formData();
	} catch (err) {
		return badRequest(`Invalid multipart body: ${err}`);
	}

	const file = form.get('file');
	const userId = (form.get('userId') as string | null)?.trim() || '';
	const titleOverride = (form.get('title') as string | null)?.trim() || null;

	if (!(file instanceof File)) return badRequest('Missing file part');
	if (!userId) return badRequest('Missing userId form field');
	if (file.size === 0) return badRequest('Empty file');
	if (file.size > MAX_FILE_BYTES) {
		return Response.json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds 10MB' } }, { status: 413 });
	}

	const fileType = file.type || 'application/octet-stream';
	if (!isRasterImage(fileType)) {
		return Response.json(
			{ success: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported file type: ${fileType}` } },
			{ status: 415 },
		);
	}

	const extension = extensionFromMime(fileType, file.name);
	const storageKey = `users/${userId}/illustrations/${crypto.randomUUID()}.${extension}`;

	try {
		await env.R2.put(storageKey, file.stream(), {
			httpMetadata: { contentType: fileType, cacheControl: 'private, max-age=31536000' },
		});
	} catch (err) {
		logError('INGEST_GENERATED', 'R2 put failed', { storageKey, error: String(err) });
		return Response.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'R2 put failed' } }, { status: 500 });
	}

	const title = titleOverride ? titleOverride.slice(0, 200) : null;

	const db = await createDbClient(env);
	let userFileId: string;
	try {
		const row = await insertBlobUserFile(db, {
			userId,
			storageKey,
			fileSize: file.size,
			fileType,
			fileName: storageKey.split('/').pop() ?? storageKey,
			originType: 'generated',
			title,
		});
		userFileId = row.id;
	} catch (err) {
		logError('INGEST_GENERATED', 'DB insert failed', { storageKey, error: String(err) });
		await env.R2.delete(storageKey).catch((delErr) =>
			logError('INGEST_GENERATED', 'R2 cleanup after DB failure also failed', { storageKey, error: String(delErr) }),
		);
		return Response.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'DB insert failed' } }, { status: 500 });
	} finally {
		await db.end();
	}

	logInfo('INGEST_GENERATED', 'Stored generated image', { userFileId, storageKey, fileType, fileSize: file.size });

	return Response.json({
		success: true,
		result: { userFileId, storageKey, fileType, fileSize: file.size, title },
	});
}
