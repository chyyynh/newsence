import { USER_FILES_TABLE } from '@core-shared/article-store';
import { extensionFromMime, isRasterImage, MAGIC_SNIFF_BYTES, PDF_MIME, sniffMediaType } from '@core-shared/mime';
import { MAX_UPLOAD_BYTES, PayloadTooLargeError, streamWithByteLimit } from '@core-shared/web';
import { createUserFileWorkflow } from '@ingest/workflow';
import { Client } from 'pg';

const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED';

const UPLOAD_CACHE_CONTROL = 'private, max-age=31536000';
const UPLOAD_FILE_QUOTA_EXCEEDED_MESSAGE = 'Upload file quota exceeded';
const UPLOAD_STORAGE_QUOTA_EXCEEDED_MESSAGE = 'Upload storage quota exceeded';
const FREE_MAX_USER_FILE_STORAGE_BYTES = 100 * 1024 * 1024;
const FREE_MAX_USER_FILES = 50;
const UNLIMITED_UPLOAD_PLANS = new Set(['pro', 'test']);

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
	| 'QUOTA_EXCEEDED'
	| 'UNSUPPORTED_MEDIA_TYPE'
	| 'INTERNAL_ERROR';

export type IngestBlobOutcome = { ok: true; result: BlobIngestResult } | { ok: false; code: IngestBlobErrorCode; message: string };

export interface IngestUploadedFileArgs {
	userId: string;
	fileName: string;
	contentType: string;
	bytes: Uint8Array;
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

type PersistBlobResult = { ok: true; userFileId: string } | { ok: false; code: 'QUOTA_EXCEEDED' | 'INTERNAL_ERROR'; message: string };

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
			code: 'BAD_REQUEST' | 'PAYLOAD_TOO_LARGE' | 'QUOTA_EXCEEDED' | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_ERROR';
			message: string;
	  };

export type PersistSavedUrlBlobResult =
	| { ok: true; userFileId: string; fileType: string; fileSize: number; title: string }
	| { ok: false; code: 'PAYLOAD_TOO_LARGE' | 'QUOTA_EXCEEDED' | 'INTERNAL_ERROR'; message: string };

class UploadQuotaExceededError extends Error {
	constructor(
		message: string,
		readonly details: Record<string, unknown>,
	) {
		super(message);
		this.name = 'UploadQuotaExceededError';
	}
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

async function assertBlobUploadQuotaTx(db: Client, userId: string, incomingBytes: number): Promise<void> {
	await db.query('SELECT pg_advisory_xact_lock(752617, hashtext($1))', [userId]);

	const settings = await db.query<{ plan_id: string }>('SELECT plan_id FROM user_settings WHERE user_id = $1 LIMIT 1', [userId]);
	const planId = settings.rows[0]?.plan_id ?? 'free';
	if (UNLIMITED_UPLOAD_PLANS.has(planId)) return;

	const usage = await db.query<{ total_bytes: string | null; total_files: string }>(
		`SELECT COALESCE(SUM(file_size), 0)::text AS total_bytes, COUNT(*)::text AS total_files
		 FROM user_files
		 WHERE user_id = $1
		   AND resource_kind = 'blob'`,
		[userId],
	);
	const currentBytes = Number.parseInt(usage.rows[0]?.total_bytes ?? '0', 10);
	const currentFiles = Number.parseInt(usage.rows[0]?.total_files ?? '0', 10);

	if (currentFiles >= FREE_MAX_USER_FILES) {
		throw new UploadQuotaExceededError(UPLOAD_FILE_QUOTA_EXCEEDED_MESSAGE, {
			limit: FREE_MAX_USER_FILES,
			used: currentFiles,
			planId,
		});
	}

	if (currentBytes + incomingBytes > FREE_MAX_USER_FILE_STORAGE_BYTES) {
		throw new UploadQuotaExceededError(UPLOAD_STORAGE_QUOTA_EXCEEDED_MESSAGE, {
			limit: FREE_MAX_USER_FILE_STORAGE_BYTES,
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

export async function ingestUploadedFile(env: Env, args: IngestUploadedFileArgs): Promise<IngestBlobOutcome> {
	// Per-user throttle, mirroring the URL ingest paths.
	const { success } = await env.USER_INGEST_LIMITER.limit({ key: `user:${args.userId}` });
	if (!success) {
		return { ok: false, code: 'RATE_LIMITED', message: 'Too many ingest requests; retry shortly.' };
	}

	if (args.bytes.byteLength === 0) {
		return { ok: false, code: 'BAD_REQUEST', message: 'Empty file' };
	}
	if (args.bytes.byteLength > MAX_UPLOAD_BYTES) {
		return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds 10MB' };
	}

	const fileType = args.contentType || 'application/octet-stream';
	if (fileType !== PDF_MIME && !isRasterImage(fileType)) {
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported file type: ${fileType}` };
	}

	// Declared MIME is client-controlled, so verify the actual file signature
	// before storing — and require the sniffed family (image vs PDF) to match the
	// declared one, so a PDF can't masquerade as an image (or vice-versa) and slip
	// past the declared-type gate above.
	const header = args.bytes.subarray(0, MAGIC_SNIFF_BYTES);
	const sniffed = sniffMediaType(header);
	if (!sniffed || (sniffed === PDF_MIME) !== (fileType === PDF_MIME)) {
		return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'File content does not match a supported image or PDF format' };
	}

	const storageKey = userUploadKey(args.userId, extensionFromMime(fileType, args.fileName));
	try {
		await env.R2.put(storageKey, args.bytes, { httpMetadata: { contentType: fileType, cacheControl: UPLOAD_CACHE_CONTROL } });
	} catch (err) {
		console.error({ tag: 'INGEST_BLOB', msg: 'R2 put failed', storageKey, error: String(err) });
		return { ok: false, code: 'INTERNAL_ERROR', message: 'R2 put failed' };
	}

	const title = args.title?.trim() || args.fileName.replace(/\.[a-z0-9]{1,8}$/i, '') || args.fileName;
	const persisted = await persistBlobRow(env, {
		userId: args.userId,
		storageKey,
		fileSize: args.bytes.byteLength,
		fileType,
		fileName: args.fileName,
		originType: 'upload',
		title,
		metadata:
			fileType === PDF_MIME
				? { type: 'pdf' as const, fetchedAt: new Date().toISOString(), data: { fileName: args.fileName, fileSize: args.bytes.byteLength } }
				: null,
	});
	if (!persisted.ok) return persisted;

	const instanceId = fileType === PDF_MIME ? await createUserFileWorkflow(env, persisted.userFileId) : undefined;

	console.info({
		tag: 'INGEST_BLOB',
		msg: 'Stored blob',
		userFileId: persisted.userFileId,
		storageKey,
		fileType,
		fileSize: args.bytes.byteLength,
	});
	return {
		ok: true,
		result: {
			userFileId: persisted.userFileId,
			storageKey,
			assetUrl: storageKeyToAssetUrl(storageKey),
			fileType,
			fileSize: args.bytes.byteLength,
			title,
			originType: 'upload',
			instanceId,
		},
	};
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
	let stored: R2Object | null;
	try {
		stored = await env.R2.put(storageKey, limited, {
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
	if (!stored) return { ok: false, code: 'INTERNAL_ERROR', message: 'R2 put failed' };

	const fileSize = stored.size;
	const title = args.suggestedFilename.replace(/\.[a-z0-9]{1,8}$/i, '') || args.suggestedFilename;
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

	const storageKey = `users/${args.userId}/illustrations/${crypto.randomUUID()}.${extensionFromMime(args.contentType)}`;
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
