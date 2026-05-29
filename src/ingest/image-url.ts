/**
 * Ingest an external image URL into the user's R2 namespace + `user_files`.
 *
 * Counterpart to `ingestBlob` (multipart). Lives in the worker (not Vercel)
 * because Workers' `fetch()` cannot reach private/loopback/cloud-metadata IPs,
 * so the SSRF blast radius collapses to "the public internet" without
 * application-level IP allowlisting.
 *
 * Result shape mirrors `IngestBlobOutcome` so both blob paths produce the
 * same `IngestBlobOutcome['result']` envelope at the HTTP boundary.
 */

import { storageKeyToAssetUrl } from '@shared/asset-url';
import { createDbClient, insertBlobUserFile } from '@shared/db/articles';
import { logError, logInfo } from '@shared/log';
import { extensionFromMime, isRasterImage } from '@shared/mime';
import { PayloadTooLargeError, streamWithByteLimit } from '@shared/streams';
import type { Env } from '@shared/types';
import type { BlobIngestResult } from './blob';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TITLE = 'image';

export type IngestImageUrlErrorCode =
	| 'BAD_REQUEST'
	| 'UNAUTHORIZED'
	| 'RATE_LIMITED'
	| 'PAYLOAD_TOO_LARGE'
	| 'UNSUPPORTED_MEDIA_TYPE'
	| 'UPSTREAM_ERROR'
	| 'INTERNAL_ERROR';

export type IngestImageUrlOutcome = { ok: true; result: BlobIngestResult } | { ok: false; code: IngestImageUrlErrorCode; message: string };

export interface IngestImageUrlArgs {
	imageUrl: string;
	userId?: string;
	title?: string | null;
}

function parseImageUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return { ok: false, message: 'Invalid image URL' };
	}
	if (parsed.protocol !== 'https:') return { ok: false, message: 'Image URL must use HTTPS' };
	if (parsed.username || parsed.password) return { ok: false, message: 'Image URL must not include credentials' };
	return { ok: true, url: parsed };
}

export async function ingestImageUrl(env: Env, args: IngestImageUrlArgs): Promise<IngestImageUrlOutcome> {
	if (!args.userId) {
		return { ok: false, code: 'UNAUTHORIZED', message: 'userId is required' };
	}
	const userId = args.userId;

	const trimmed = args.imageUrl.trim();
	if (!trimmed) {
		return { ok: false, code: 'BAD_REQUEST', message: 'imageUrl is required' };
	}
	const urlCheck = parseImageUrl(trimmed);
	if (!urlCheck.ok) {
		return { ok: false, code: 'BAD_REQUEST', message: urlCheck.message };
	}

	const { success } = await env.USER_INGEST_LIMITER.limit({ key: `user:${userId}` });
	if (!success) {
		return { ok: false, code: 'RATE_LIMITED', message: 'Too many ingest requests; retry shortly.' };
	}

	let upstream: Response;
	try {
		upstream = await fetch(urlCheck.url.toString(), { redirect: 'follow' });
	} catch (err) {
		return { ok: false, code: 'UPSTREAM_ERROR', message: `Fetch failed: ${err}` };
	}
	if (!upstream.ok) {
		return { ok: false, code: 'UPSTREAM_ERROR', message: `Upstream returned ${upstream.status}` };
	}
	if (!upstream.body) {
		return { ok: false, code: 'UPSTREAM_ERROR', message: 'Upstream body is empty' };
	}

	const contentType = upstream.headers.get('content-type')?.split(';')[0].trim() || '';
	if (!isRasterImage(contentType)) {
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'URL must point to a raster image' };
	}
	const declaredLength = upstream.headers.get('content-length');
	if (declaredLength && Number.parseInt(declaredLength, 10) > MAX_IMAGE_BYTES) {
		return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'Image exceeds 10MB' };
	}

	const extension = extensionFromMime(contentType);
	const storageKey = `users/${userId}/uploads/${crypto.randomUUID()}.${extension}`;

	const limited = streamWithByteLimit(upstream.body, MAX_IMAGE_BYTES);
	try {
		await env.R2.put(storageKey, limited.stream, {
			httpMetadata: { contentType, cacheControl: 'private, max-age=31536000' },
		});
	} catch (err) {
		if (err instanceof PayloadTooLargeError) {
			return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'Image exceeds 10MB' };
		}
		logError('INGEST_IMAGE_URL', 'R2 put failed', { imageUrl: trimmed, storageKey, error: String(err) });
		return { ok: false, code: 'INTERNAL_ERROR', message: 'R2 put failed' };
	}

	const fileSize = limited.getBytesSeen();
	const fileName = storageKey.split('/').pop() ?? storageKey;
	const title = args.title?.trim() || DEFAULT_TITLE;

	const db = await createDbClient(env);
	let userFileId: string;
	try {
		const row = await insertBlobUserFile(db, {
			userId,
			storageKey,
			fileSize,
			fileType: contentType,
			fileName,
			originType: 'upload',
			title,
			sourceUrl: trimmed,
			normalizedSourceUrl: trimmed,
			metadata: null,
		});
		userFileId = row.id;
	} catch (err) {
		logError('INGEST_IMAGE_URL', 'DB insert failed', { imageUrl: trimmed, storageKey, error: String(err) });
		await env.R2.delete(storageKey).catch((delErr) =>
			logError('INGEST_IMAGE_URL', 'R2 cleanup after DB failure also failed', { storageKey, error: String(delErr) }),
		);
		return { ok: false, code: 'INTERNAL_ERROR', message: 'DB insert failed' };
	} finally {
		await db.end();
	}

	logInfo('INGEST_IMAGE_URL', 'Stored image', { userFileId, storageKey, contentType, fileSize });

	return {
		ok: true,
		result: {
			userFileId,
			storageKey,
			assetUrl: storageKeyToAssetUrl(storageKey),
			fileType: contentType,
			fileSize,
			title,
			originType: 'upload',
		},
	};
}
