/**
 * Blob ingest: write an uploaded/webed file into the user's R2 namespace +
 * a `resource_kind='blob'` row in `user_files`. Two public entry points share
 * the same storage plumbing and result envelope:
 *
 *   - `ingestBlob`      — multipart upload (client sends the bytes)
 *   - `ingestImageUrl`  — external image URL (worker fetches the bytes)
 *
 * `ingestImageUrl` lives here (not Vercel) because Workers' `fetch()` cannot
 * reach private/loopback/cloud-metadata IPs, so the SSRF blast radius collapses
 * to "the public internet" without application-level IP allowlisting.
 *
 * The shared R2 write + DB row commit boundary lives in `blob-persistence`
 * because URL-ingested PDFs/images and multipart uploads need identical
 * compensating cleanup if the database commit fails.
 */

import {
	extensionFromMime,
	isRasterImage,
	MAGIC_SNIFF_BYTES,
	PDF_MIME,
	sniffMediaType,
	sniffMediaTypeStream,
	UnsupportedMediaError,
} from '@shared/mime';
import type { Env } from '@shared/types';
import {
	buildPdfMetadata,
	deriveFileTitle,
	MAX_UPLOAD_BYTES,
	PayloadTooLargeError,
	storageKeyToAssetUrl,
	streamWithByteLimit,
	userUploadKey,
} from '@shared/upload';
import { assertExternalFetchable, BROWSER_UA, fetchWithTimeout } from '@shared/web';
import { createUserFileWorkflow } from '@shared/workflow-queue';
import { persistBlobRow, putUserUpload } from './blob-persistence';

const DEFAULT_IMAGE_TITLE = 'image';

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

export type IngestBlobErrorCode =
	| 'BAD_REQUEST'
	| 'RATE_LIMITED'
	| 'PAYLOAD_TOO_LARGE'
	| 'QUOTA_EXCEEDED'
	| 'UNSUPPORTED_MEDIA_TYPE'
	| 'INTERNAL_ERROR';

export type IngestBlobOutcome = { ok: true; result: BlobIngestResult } | { ok: false; code: IngestBlobErrorCode; message: string };

export type IngestImageUrlErrorCode = IngestBlobErrorCode | 'UNAUTHORIZED' | 'UPSTREAM_ERROR';

export type IngestImageUrlOutcome = { ok: true; result: BlobIngestResult } | { ok: false; code: IngestImageUrlErrorCode; message: string };

export interface IngestImageUrlArgs {
	imageUrl: string;
	userId?: string;
	title?: string | null;
}

function buildBlobResult(args: {
	userFileId: string;
	storageKey: string;
	fileType: string;
	fileSize: number;
	title: string | null;
	instanceId?: string;
}): BlobIngestResult {
	return {
		userFileId: args.userFileId,
		storageKey: args.storageKey,
		assetUrl: storageKeyToAssetUrl(args.storageKey),
		fileType: args.fileType,
		fileSize: args.fileSize,
		title: args.title,
		originType: 'upload',
		instanceId: args.instanceId,
	};
}

// ── Multipart upload ─────────────────────────────────────────────────────────

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
	if (file.size > MAX_UPLOAD_BYTES) {
		return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds 10MB' };
	}

	const fileType = file.type || 'application/octet-stream';
	if (fileType !== PDF_MIME && !isRasterImage(fileType)) {
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported file type: ${fileType}` };
	}

	// Declared MIME is client-controlled, so verify the actual file signature
	// before storing — and require the sniffed family (image vs PDF) to match the
	// declared one, so a PDF can't masquerade as an image (or vice-versa) and slip
	// past the declared-type gate above.
	const header = new Uint8Array(await file.slice(0, MAGIC_SNIFF_BYTES).arrayBuffer());
	const sniffed = sniffMediaType(header);
	if (!sniffed || (sniffed === PDF_MIME) !== (fileType === PDF_MIME)) {
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'File content does not match a supported image or PDF format' };
	}

	const storageKey = userUploadKey(userId, extensionFromMime(fileType, file.name));
	try {
		await putUserUpload(env, { storageKey, body: file.stream(), contentType: fileType });
	} catch (err) {
		console.error({ tag: 'INGEST_BLOB', msg: 'R2 put failed', storageKey, error: String(err) });
		return { ok: false, code: 'INTERNAL_ERROR', message: 'R2 put failed' };
	}

	const title = titleOverride ?? deriveFileTitle(file.name);
	const persisted = await persistBlobRow(env, {
		userId,
		storageKey,
		fileSize: file.size,
		fileType,
		fileName: file.name,
		originType: 'upload',
		title,
		metadata: buildPdfMetadata({ fileType, fileName: file.name, fileSize: file.size }),
	});
	if (!persisted.ok) return persisted;

	// Only PDFs trigger the AI workflow today — images have no text to analyze.
	const instanceId = fileType === PDF_MIME ? await createUserFileWorkflow(env, persisted.userFileId) : undefined;

	console.info({ tag: 'INGEST_BLOB', msg: 'Stored blob', userFileId: persisted.userFileId, storageKey, fileType, fileSize: file.size });
	return { ok: true, result: buildBlobResult({ ...persisted, storageKey, fileType, fileSize: file.size, title, instanceId }) };
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
	let parsedUrl: URL;
	try {
		parsedUrl = assertExternalFetchable(trimmed);
	} catch (err) {
		return { ok: false, code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Invalid image URL' };
	}

	const { success } = await env.USER_INGEST_LIMITER.limit({ key: `user:${userId}` });
	if (!success) {
		return { ok: false, code: 'RATE_LIMITED', message: 'Too many ingest requests; retry shortly.' };
	}

	let upstream: Response;
	try {
		upstream = await fetchWithTimeout(parsedUrl.toString(), {
			redirect: 'follow',
			headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*;q=0.8' },
		});
	} catch (err) {
		return { ok: false, code: 'UPSTREAM_ERROR', message: `Fetch failed: ${err}` };
	}
	if (!upstream.ok) {
		await upstream.body?.cancel();
		return { ok: false, code: 'UPSTREAM_ERROR', message: `Upstream returned ${upstream.status}` };
	}
	if (!upstream.body) {
		return { ok: false, code: 'UPSTREAM_ERROR', message: 'Upstream body is empty' };
	}

	const contentType = upstream.headers.get('content-type')?.split(';')[0].trim() || '';
	if (!isRasterImage(contentType)) {
		await upstream.body.cancel();
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'URL must point to a raster image' };
	}
	const declaredLength = upstream.headers.get('content-length');
	if (declaredLength && Number.parseInt(declaredLength, 10) > MAX_UPLOAD_BYTES) {
		await upstream.body.cancel();
		return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'Image exceeds 10MB' };
	}

	const storageKey = userUploadKey(userId, extensionFromMime(contentType));

	// Size cap then signature check, both fail-before-commit: the upstream
	// Content-Type was attacker-influenced, so confirm the bytes are a real raster
	// image (no PDF/SVG/HTML) before R2 commits the object.
	const limited = streamWithByteLimit(upstream.body, MAX_UPLOAD_BYTES);
	const sniffed = sniffMediaTypeStream(limited.stream, (type) => type !== 'application/pdf');
	try {
		await putUserUpload(env, { storageKey, body: sniffed.stream, contentType });
	} catch (err) {
		if (err instanceof PayloadTooLargeError) {
			return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'Image exceeds 10MB' };
		}
		if (err instanceof UnsupportedMediaError) {
			return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'URL content is not a supported raster image' };
		}
		console.error({ tag: 'INGEST_IMAGE_URL', msg: 'R2 put failed', imageUrl: trimmed, storageKey, error: String(err) });
		return { ok: false, code: 'INTERNAL_ERROR', message: 'R2 put failed' };
	}

	const fileSize = limited.getBytesSeen();
	const title = args.title?.trim() || DEFAULT_IMAGE_TITLE;
	const persisted = await persistBlobRow(env, {
		userId,
		storageKey,
		fileSize,
		fileType: contentType,
		fileName: storageKey.split('/').pop() ?? storageKey,
		originType: 'upload',
		title,
		sourceUrl: trimmed,
		normalizedSourceUrl: trimmed,
		metadata: null,
	});
	if (!persisted.ok) return persisted;

	console.info({ tag: 'INGEST_IMAGE_URL', msg: 'Stored image', userFileId: persisted.userFileId, storageKey, contentType, fileSize });
	return { ok: true, result: buildBlobResult({ ...persisted, storageKey, fileType: contentType, fileSize, title }) };
}
