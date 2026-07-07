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
 */

import { USER_FILES_TABLE } from '@core-shared/article-store';
import {
	extensionFromMime,
	isRasterImage,
	MAGIC_SNIFF_BYTES,
	PDF_MIME,
	sniffMediaType,
	sniffMediaTypeStream,
	UnsupportedMediaError,
} from '@core-shared/mime';
import {
	assertExternalFetchable,
	BROWSER_UA,
	fetchWithTimeout,
	MAX_UPLOAD_BYTES,
	PayloadTooLargeError,
	streamWithByteLimit,
} from '@core-shared/web';
import { createUserFileWorkflow } from '@ingest/workflows/queue';
import { Client } from 'pg';

export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';
type QuotaExceededCode = typeof QUOTA_EXCEEDED_CODE;

const DEFAULT_IMAGE_TITLE = 'image';
const UPLOAD_CACHE_CONTROL = 'private, max-age=31536000';
const UPLOAD_FILE_QUOTA_EXCEEDED_MESSAGE = 'Upload file quota exceeded';
const UPLOAD_STORAGE_QUOTA_EXCEEDED_MESSAGE = 'Upload storage quota exceeded';
const FREE_MAX_USER_FILE_STORAGE_BYTES = 100 * 1024 * 1024;
const FREE_MAX_USER_FILES = 50;
const UNLIMITED_UPLOAD_PLANS = new Set(['pro', 'test']);

type BlobUploadQuota = {
	maxUserFileStorageBytes: number | null;
	maxUserFiles: number | null;
};

interface BlobIngestResult {
	userFileId: string;
	storageKey: string;
	assetUrl: string;
	fileType: string;
	fileSize: number;
	title: string | null;
	originType: 'upload';
	instanceId?: string;
}

type IngestBlobErrorCode =
	| 'BAD_REQUEST'
	| 'RATE_LIMITED'
	| 'PAYLOAD_TOO_LARGE'
	| QuotaExceededCode
	| 'UNSUPPORTED_MEDIA_TYPE'
	| 'INTERNAL_ERROR';

export type IngestBlobOutcome = { ok: true; result: BlobIngestResult } | { ok: false; code: IngestBlobErrorCode; message: string };

type IngestImageUrlErrorCode = IngestBlobErrorCode | 'UNAUTHORIZED' | 'UPSTREAM_ERROR';

export type IngestImageUrlOutcome = { ok: true; result: BlobIngestResult } | { ok: false; code: IngestImageUrlErrorCode; message: string };

export interface IngestImageUrlArgs {
	imageUrl: string;
	userId?: string;
	title?: string | null;
}

interface InsertBlobUserFileData {
	userId: string;
	storageKey: string;
	fileSize: number;
	fileType: string;
	fileName: string;
	originType: 'upload' | 'saved_url' | 'generated';
	title?: string | null;
	sourceUrl?: string | null;
	normalizedSourceUrl?: string | null;
	metadata?: unknown | null;
}

type PersistBlobResult = { ok: true; userFileId: string } | { ok: false; code: QuotaExceededCode | 'INTERNAL_ERROR'; message: string };

export type PersistGeneratedImageResult =
	| {
			ok: true;
			result: {
				userFileId: string;
				storageKey: string;
				assetUrl: string;
				fileType: string;
				fileSize: number;
			};
	  }
	| {
			ok: false;
			code: 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE' | QuotaExceededCode | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_ERROR';
			message: string;
	  };

export type PersistSavedUrlBlobResult =
	| { ok: true; userFileId: string; fileType: string; fileSize: number; title: string }
	| { ok: false; code: 'PAYLOAD_TOO_LARGE' | QuotaExceededCode | 'INTERNAL_ERROR'; message: string };

class UploadQuotaExceededError extends Error {
	constructor(
		message: string,
		readonly details: Record<string, unknown>,
	) {
		super(message);
		this.name = 'UploadQuotaExceededError';
	}
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

function deriveFileTitle(fileName: string): string {
	return fileName.replace(/\.[a-z0-9]{1,8}$/i, '') || fileName;
}

function storageKeyToAssetUrl(key: string): string {
	const encodedPath = key
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	return `/api/media/asset/${encodedPath}`;
}

function userUploadKey(userId: string, extension: string): string {
	return `users/${userId}/uploads/${crypto.randomUUID()}.${extension}`;
}

function userGeneratedImageKey(userId: string, extension: string): string {
	return `users/${userId}/illustrations/${crypto.randomUUID()}.${extension}`;
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

async function assertBlobUploadQuotaTx(db: Client, userId: string, incomingBytes: number): Promise<void> {
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
		throw new UploadQuotaExceededError(UPLOAD_FILE_QUOTA_EXCEEDED_MESSAGE, {
			limit: maxUserFiles,
			used: currentFiles,
			planId,
		});
	}

	if (maxUserFileStorageBytes !== null && currentBytes + incomingBytes > maxUserFileStorageBytes) {
		throw new UploadQuotaExceededError(UPLOAD_STORAGE_QUOTA_EXCEEDED_MESSAGE, {
			limit: maxUserFileStorageBytes,
			used: currentBytes,
			incoming: incomingBytes,
			planId,
		});
	}
}

async function insertBlobUserFile(db: Client, data: InsertBlobUserFileData): Promise<{ id: string }> {
	const title = data.title ? data.title.slice(0, 200) : null;
	const result = await db.query(
		`INSERT INTO ${USER_FILES_TABLE}
			(file_name, file_type, file_size, storage_key, resource_kind, origin_type, platform_type,
			 source_url, normalized_source_url, title, metadata, user_id)
		 VALUES ($1, $2, $3, $4, 'blob', $5, NULL, $6, $7, $8, $9, $10)
		 RETURNING id`,
		[
			data.fileName,
			data.fileType,
			data.fileSize,
			data.storageKey,
			data.originType,
			data.sourceUrl ?? null,
			data.normalizedSourceUrl ?? null,
			title,
			data.metadata === null || data.metadata === undefined ? null : JSON.stringify(data.metadata),
			data.userId,
		],
	);
	const id = result.rows[0]?.id as string | undefined;
	if (!id) throw new Error('insertBlobUserFile returned no id');
	return { id };
}

async function persistBlobRow(env: Env, data: InsertBlobUserFileData): Promise<PersistBlobResult> {
	try {
		const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
		await db.connect();
		await db.query('BEGIN');
		let row: { id: string };
		try {
			await assertBlobUploadQuotaTx(db, data.userId, data.fileSize);
			row = await insertBlobUserFile(db, data);
			await db.query('COMMIT');
		} catch (error) {
			await db
				.query('ROLLBACK')
				.catch((rollbackError) => console.error({ tag: 'DB', msg: 'blob row insert rollback failed', error: String(rollbackError) }));
			throw error;
		}
		return { ok: true, userFileId: row.id };
	} catch (err) {
		console.error({ tag: 'PERSIST_BLOB', msg: 'blob row insert failed', storageKey: data.storageKey, error: String(err) });
		await env.R2.delete(data.storageKey).catch((delErr) =>
			console.error({
				tag: 'PERSIST_BLOB',
				msg: 'R2 cleanup after DB failure also failed',
				storageKey: data.storageKey,
				error: String(delErr),
			}),
		);
		if (err instanceof UploadQuotaExceededError) {
			return { ok: false, code: QUOTA_EXCEEDED_CODE, message: err.message };
		}
		return { ok: false, code: 'INTERNAL_ERROR', message: 'DB insert failed' };
	}
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
		await env.R2.put(storageKey, file.stream(), { httpMetadata: { contentType: fileType, cacheControl: UPLOAD_CACHE_CONTROL } });
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
		metadata:
			fileType === PDF_MIME
				? { type: 'pdf' as const, fetchedAt: new Date().toISOString(), data: { fileName: file.name, fileSize: file.size } }
				: null,
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
		await env.R2.put(storageKey, sniffed.stream, { httpMetadata: { contentType, cacheControl: UPLOAD_CACHE_CONTROL } });
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

export async function persistSavedUrlBlob(
	env: Env,
	args: {
		userId: string;
		body: ReadableStream<Uint8Array>;
		contentLength: number | null;
		contentType: string;
		suggestedFilename: string;
		sourceUrl: string;
		normalizedSourceUrl: string;
	},
): Promise<PersistSavedUrlBlobResult> {
	if (args.contentLength !== null && args.contentLength > MAX_UPLOAD_BYTES) {
		await args.body.cancel();
		return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: `Resource exceeds ${MAX_UPLOAD_BYTES} bytes (declared ${args.contentLength})` };
	}

	const storageKey = userUploadKey(args.userId, extensionFromMime(args.contentType, args.suggestedFilename));
	const limited = streamWithByteLimit(args.body, MAX_UPLOAD_BYTES);
	try {
		await env.R2.put(storageKey, limited.stream, {
			httpMetadata: { contentType: args.contentType, cacheControl: UPLOAD_CACHE_CONTROL },
		});
	} catch (err) {
		if (err instanceof PayloadTooLargeError) {
			return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: `Resource exceeds ${MAX_UPLOAD_BYTES} bytes` };
		}
		console.error({
			tag: 'PERSIST_BLOB',
			msg: 'R2 put failed for saved URL blob',
			url: args.normalizedSourceUrl,
			storageKey,
			error: String(err),
		});
		return { ok: false, code: 'INTERNAL_ERROR', message: 'R2 put failed' };
	}

	const fileSize = limited.getBytesSeen();
	const title = deriveFileTitle(args.suggestedFilename);
	const persisted = await persistBlobRow(env, {
		userId: args.userId,
		storageKey,
		fileSize,
		fileType: args.contentType,
		fileName: args.suggestedFilename,
		originType: 'saved_url',
		title,
		sourceUrl: args.sourceUrl,
		normalizedSourceUrl: args.normalizedSourceUrl,
		metadata:
			args.contentType === PDF_MIME
				? { type: 'pdf' as const, fetchedAt: new Date().toISOString(), data: { fileName: args.suggestedFilename, fileSize } }
				: null,
	});
	if (!persisted.ok) return persisted;

	return { ok: true, userFileId: persisted.userFileId, fileType: args.contentType, fileSize, title };
}

export async function persistGeneratedImage(
	env: Env,
	args: { userId: string; bytes: Uint8Array; contentType: string; title: string },
): Promise<PersistGeneratedImageResult> {
	if (!args.userId) return { ok: false, code: 'BAD_REQUEST', message: 'userId is required' };
	if (args.bytes.byteLength === 0) return { ok: false, code: 'BAD_REQUEST', message: 'image is empty' };
	if (args.bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'Generated image exceeds 10MB' };
	if (!isRasterImage(args.contentType)) {
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported image type: ${args.contentType}` };
	}

	const storageKey = userGeneratedImageKey(args.userId, extensionFromMime(args.contentType));
	const fileName = storageKey.split('/').pop() ?? storageKey;

	try {
		await env.R2.put(storageKey, args.bytes, { httpMetadata: { contentType: args.contentType, cacheControl: UPLOAD_CACHE_CONTROL } });
	} catch (err) {
		console.error({ tag: 'GENERATED_IMAGE', msg: 'R2 put failed', storageKey, error: String(err) });
		return { ok: false, code: 'INTERNAL_ERROR', message: 'R2 put failed' };
	}

	const persisted = await persistBlobRow(env, {
		userId: args.userId,
		storageKey,
		fileSize: args.bytes.byteLength,
		fileType: args.contentType,
		fileName,
		originType: 'generated',
		title: args.title,
		metadata: null,
	});
	if (!persisted.ok) return persisted;

	console.info({
		tag: 'GENERATED_IMAGE',
		msg: 'Stored generated image',
		userFileId: persisted.userFileId,
		storageKey,
		fileType: args.contentType,
		fileSize: args.bytes.byteLength,
	});
	return {
		ok: true,
		result: {
			userFileId: persisted.userFileId,
			storageKey,
			assetUrl: storageKeyToAssetUrl(storageKey),
			fileType: args.contentType,
			fileSize: args.bytes.byteLength,
		},
	};
}
