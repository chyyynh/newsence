import { USER_FILES_TABLE } from '@shared/article-store';
import { type DbClient, withDbTransaction } from '@shared/db';
import { extensionFromMime, isRasterImage } from '@shared/mime';
import type { Env } from '@shared/types';
import {
	assertBlobUploadQuotaTx,
	buildPdfMetadata,
	deriveFileTitle,
	MAX_UPLOAD_BYTES,
	PayloadTooLargeError,
	storageKeyToAssetUrl,
	streamWithByteLimit,
	UploadQuotaExceededError,
	userGeneratedImageKey,
	userUploadKey,
} from '@shared/upload';

const UPLOAD_CACHE_CONTROL = 'private, max-age=31536000';

export interface InsertBlobUserFileData {
	userId: string;
	storageKey: string;
	fileSize: number;
	fileType: string;
	fileName: string;
	originType: 'upload' | 'saved_url' | 'generated';
	title?: string | null;
	/** Set for `saved_url` to enable per-user URL dedup. */
	sourceUrl?: string | null;
	normalizedSourceUrl?: string | null;
	/** PlatformMetadata envelope ({ type, fetchedAt, data, ... }) or null. */
	metadata?: unknown | null;
}

export type PersistBlobResult =
	| { ok: true; userFileId: string }
	| { ok: false; code: 'QUOTA_EXCEEDED' | 'INTERNAL_ERROR'; message: string };

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

function serializeMetadata(metadata: unknown | null): string | null {
	if (metadata === null || metadata === undefined) return null;
	return JSON.stringify(metadata);
}

/**
 * Write an upload object to R2 with the standard upload cache headers. Throws on
 * failure (R2 never commits a partial object) so callers can map failure modes
 * to their own endpoint-specific error codes.
 */
export async function putUserUpload(
	env: Env,
	args: { storageKey: string; body: ReadableStream<Uint8Array> | Uint8Array; contentType: string },
): Promise<void> {
	await env.R2.put(args.storageKey, args.body, {
		httpMetadata: { contentType: args.contentType, cacheControl: UPLOAD_CACHE_CONTROL },
	});
}

async function insertBlobUserFile(db: DbClient, data: InsertBlobUserFileData): Promise<{ id: string }> {
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
			serializeMetadata(data.metadata ?? null),
			data.userId,
		],
	);
	const id = result.rows[0]?.id as string | undefined;
	if (!id) throw new Error('insertBlobUserFile returned no id');
	return { id };
}

/**
 * Commit a blob's `user_files` row inside a quota-guarded transaction, deleting
 * the already-staged R2 object (`data.storageKey`) if the transaction can't
 * commit. The caller must have written that object via `putUserUpload` first.
 */
export async function persistBlobRow(env: Env, data: InsertBlobUserFileData): Promise<PersistBlobResult> {
	try {
		// Quota + insert share one transaction so the advisory lock in
		// assertBlobUploadQuotaTx serializes a user's concurrent saves and they
		// can't race past the cap. The worker is the authoritative enforcer; the
		// frontend's pre-check is best-effort UX only.
		const row = await withDbTransaction(env, 'blob row insert', async (db) => {
			await assertBlobUploadQuotaTx(db, data.userId, data.fileSize);
			return insertBlobUserFile(db, data);
		});
		return { ok: true, userFileId: row.id };
	} catch (err) {
		console.error({ tag: 'PERSIST_BLOB', msg: 'blob row insert failed', storageKey: data.storageKey, error: String(err) });
		// Compensate: drop the R2 object the caller staged. delete is strongly
		// consistent + idempotent -- best-effort, log if it also fails.
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
	}
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
		await putUserUpload(env, { storageKey, body: limited.stream, contentType: args.contentType });
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
		metadata: buildPdfMetadata({ fileType: args.contentType, fileName: args.suggestedFilename, fileSize }),
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
		await putUserUpload(env, { storageKey, body: args.bytes, contentType: args.contentType });
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
