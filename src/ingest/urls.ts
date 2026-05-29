import { storageKeyToAssetUrl } from '@shared/asset-url';
import {
	createDbClient,
	type InsertUserFileResult,
	insertBlobUserFile,
	insertUserFile,
	USER_FILES_TABLE,
	upsertYoutubeTranscript,
} from '@shared/db/articles';
import { logError, logInfo } from '@shared/log';
import { extensionFromMime } from '@shared/mime';
import { parsePlatformMetadata } from '@shared/platform-metadata-parser';
import { detectPlatformType, type ScrapedContent } from '@shared/scraped-content';
import { streamWithByteLimit } from '@shared/streams';
import type { Env } from '@shared/types';
import { assertBlobUploadQuotaTx, UploadQuotaExceededError } from '@shared/upload-quota';
import { normalizeUrl } from '@shared/web';
import { type ScrapeResult, scrapeUrl } from './platforms/registry';
import { createUserFileWorkflow } from './workflows/article-workflow-client';

const EXIST_COLS = 'id, title, title_cn, summary_cn, tags, platform_type, og_image_url, resource_kind';
const INGEST_MAX_BATCH_SIZE = 20;
const INGEST_URL_CONCURRENCY = 4;
const PDF_MIME = 'application/pdf';

type ExistingUserFileRow = {
	id: string;
	title: string;
	title_cn: string | null;
	summary_cn: string | null;
	tags: string[] | null;
	platform_type: string | null;
	og_image_url: string | null;
	resource_kind: string;
};

type IngestResult = {
	url: string;
	userFileId?: string;
	instanceId?: string;
	title?: string;
	titleCn?: string;
	summaryCn?: string;
	tags?: string[];
	ogImageUrl?: string | null;
	resourceKind?: 'url' | 'blob';
	originType?: 'saved_url';
	platformType?: string;
	fileType?: string;
	alreadyExists?: boolean;
	error?: string;
};

type IngestErrorCode = 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED';
export type IngestUrlsOutcome = { ok: true; results: IngestResult[] } | { ok: false; code: IngestErrorCode; message: string };

function deriveTitle(fileName: string, fileType: string): string {
	if (fileType === PDF_MIME) return fileName.replace(/\.pdf$/i, '');
	return fileName.replace(/\.[a-z0-9]{1,8}$/i, '');
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

type InsertOutcome =
	| { kind: 'page'; row: InsertUserFileResult }
	| { kind: 'blob'; userFileId: string; fileType: string }
	| { error: string };

async function insertScrapedPage(scraped: ScrapedContent, url: string, env: Env, userId: string): Promise<InsertOutcome> {
	const platformType = detectPlatformType(url);

	const skipContentCheck = platformType === 'youtube' || platformType === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return { error: 'Content too short' };
	}

	const db = await createDbClient(env);
	try {
		const normalizedPlatformMetadata = parsePlatformMetadata(scraped.metadata, platformType);
		const platformMetadataToStore = normalizedPlatformMetadata
			? {
					...normalizedPlatformMetadata,
					ogImageWidth: scraped.ogImageWidth ?? null,
					ogImageHeight: scraped.ogImageHeight ?? null,
				}
			: null;

		const userFile = await insertUserFile(db, {
			url,
			normalizedUrl: url,
			title: scraped.title,
			source: scraped.siteName || 'External',
			publishedDate: scraped.publishedDate || new Date().toISOString(),
			summary: scraped.summary || '',
			platformType,
			content: scraped.content || null,
			ogImageUrl: scraped.ogImageUrl || null,
			platformMetadata: platformMetadataToStore,
			userId,
		});

		if (!userFile) {
			logError('INGEST', 'DB insert failed', { url, error: 'No id returned' });
			return { error: 'DB insert failed' };
		}

		// ON CONFLICT path: row pre-existed, skip post-insert side effects.
		if (!userFile.created) {
			return { kind: 'page', row: userFile };
		}

		if (scraped.youtubeTranscript) {
			try {
				await upsertYoutubeTranscript(db, scraped.youtubeTranscript);
			} catch (transcriptErr) {
				logError('YOUTUBE', 'Failed to save transcript', {
					videoId: scraped.youtubeTranscript.videoId,
					error: String(transcriptErr),
				});
			}
		}

		logInfo('INGEST', 'Saved user_file', { title: scraped.title.slice(0, 50), userFileId: userFile.id });
		return { kind: 'page', row: userFile };
	} catch (err) {
		logError('INGEST', 'DB insert failed', { url, error: String(err) });
		return { error: 'DB insert failed' };
	} finally {
		await db.end();
	}
}

const MAX_BLOB_BYTES = 10 * 1024 * 1024;

async function insertScrapedBlob(
	blob: Extract<ScrapeResult, { kind: 'blob' }>,
	url: string,
	env: Env,
	userId: string,
): Promise<InsertOutcome> {
	try {
		// Reject before piping if upstream is honest about being oversized.
		if (blob.contentLength !== null && blob.contentLength > MAX_BLOB_BYTES) {
			await blob.body.cancel();
			return { error: `Resource exceeds ${MAX_BLOB_BYTES} bytes (declared ${blob.contentLength})` };
		}

		const ext = extensionFromMime(blob.contentType, blob.suggestedFilename);
		const storageKey = `users/${userId}/uploads/${crypto.randomUUID()}.${ext}`;

		// On overrun the transform errors, `env.R2.put` rejects, and R2 doesn't
		// commit a partial object.
		const limited = streamWithByteLimit(blob.body, MAX_BLOB_BYTES);
		try {
			await env.R2.put(storageKey, limited.stream, {
				httpMetadata: { contentType: blob.contentType, cacheControl: 'private, max-age=31536000' },
			});
		} catch (err) {
			logError('INGEST', 'R2 put failed', { url, storageKey, error: String(err) });
			return { error: 'R2 put failed' };
		}

		const fileSize = limited.getBytesSeen();
		const title = deriveTitle(blob.suggestedFilename, blob.contentType);
		const metadata = blob.contentType === PDF_MIME ? buildPdfMetadata({ fileName: blob.suggestedFilename, fileSize, storageKey }) : null;

		const db = await createDbClient(env);
		try {
			await db.query('BEGIN');
			await assertBlobUploadQuotaTx(db, userId, fileSize);
			const row = await insertBlobUserFile(db, {
				userId,
				storageKey,
				fileSize,
				fileType: blob.contentType,
				fileName: blob.suggestedFilename,
				originType: 'saved_url',
				title,
				sourceUrl: blob.sourceUrl,
				normalizedSourceUrl: url,
				metadata,
			});
			await db.query('COMMIT');
			logInfo('INGEST', 'Saved blob from URL', { title: title.slice(0, 50), userFileId: row.id, contentType: blob.contentType });
			return { kind: 'blob', userFileId: row.id, fileType: blob.contentType };
		} catch (err) {
			await db
				.query('ROLLBACK')
				.catch((rollbackErr) => logError('INGEST', 'Blob insert rollback failed', { url, storageKey, error: String(rollbackErr) }));
			logError('INGEST', 'Blob row insert failed', { url, error: String(err) });
			// Compensate: drop the R2 blob we just wrote. delete is strongly consistent
			// + idempotent — best-effort, log if it also fails.
			await env.R2.delete(storageKey).catch((delErr) =>
				logError('INGEST', 'R2 cleanup after DB failure also failed', { url, storageKey, error: String(delErr) }),
			);
			if (err instanceof UploadQuotaExceededError) {
				return { error: err.message };
			}
			return { error: 'DB insert failed' };
		} finally {
			await db.end();
		}
	} finally {
		blob.dispose();
	}
}

async function scrapeAndInsert(url: string, env: Env, userId: string): Promise<InsertOutcome> {
	const result = await scrapeUrl(url, {
		youtubeApiKey: env.YOUTUBE_API_KEY,
		kaitoApiKey: env.KAITO_API_KEY,
	});

	if (result.kind === 'page') {
		return insertScrapedPage(result.scraped, url, env, userId);
	}
	return insertScrapedBlob(result, url, env, userId);
}

function buildExistingResult(url: string, row: ExistingUserFileRow, instanceId: string | undefined): IngestResult {
	const isBlob = row.resource_kind === 'blob';
	return {
		url,
		userFileId: row.id,
		instanceId,
		resourceKind: isBlob ? 'blob' : 'url',
		originType: 'saved_url',
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags ? (Array.isArray(row.tags) ? row.tags : []) : undefined,
		ogImageUrl: row.og_image_url,
		platformType: isBlob ? undefined : row.platform_type || 'web',
		alreadyExists: true,
	};
}

async function returnExisting(url: string, row: ExistingUserFileRow, env: Env): Promise<IngestResult> {
	const sourceTypeForWorkflow = row.resource_kind === 'blob' ? 'pdf' : row.platform_type || 'web';
	const instanceId = row.title_cn ? undefined : await createUserFileWorkflow(env, row.id, sourceTypeForWorkflow);
	return buildExistingResult(url, row, instanceId);
}

export async function processUrl(rawUrl: string, env: Env, userId: string): Promise<IngestResult> {
	const url = normalizeUrl(rawUrl);

	const db = await createDbClient(env);
	try {
		const existing = await db.query<ExistingUserFileRow>(
			`SELECT ${EXIST_COLS} FROM ${USER_FILES_TABLE}
			 WHERE user_id = $1
			   AND normalized_source_url = $2
			 LIMIT 1`,
			[userId, url],
		);
		if (existing.rows.length > 0) {
			return returnExisting(url, existing.rows[0], env);
		}
	} finally {
		await db.end();
	}

	let result: InsertOutcome;
	try {
		result = await scrapeAndInsert(url, env, userId);
	} catch (err) {
		logError('INGEST', 'Scrape failed', { url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };

	if (result.kind === 'blob') {
		// PDFs run through the AI workflow for text extraction + analysis;
		// images are stored without further processing (no vision pipeline yet).
		const instanceId = result.fileType === PDF_MIME ? await createUserFileWorkflow(env, result.userFileId, 'pdf') : undefined;
		return {
			url,
			userFileId: result.userFileId,
			instanceId,
			resourceKind: 'blob',
			originType: 'saved_url',
			fileType: result.fileType,
			alreadyExists: false,
		};
	}

	const { row } = result;
	// `created=true`: fresh insert, always trigger workflow for AI enrichment.
	// `created=false`: ON CONFLICT race — a concurrent submit already triggered
	//   the workflow on the existing row, skip.
	const instanceId = row.created ? await createUserFileWorkflow(env, row.id, row.platform_type || 'web') : undefined;
	return {
		url,
		userFileId: row.id,
		instanceId,
		resourceKind: 'url',
		originType: 'saved_url',
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags?.length ? row.tags : undefined,
		ogImageUrl: row.og_image_url,
		platformType: row.platform_type || 'web',
		alreadyExists: !row.created,
	};
}

export async function ingestUrls(env: Env, args: { urls: string[]; userId?: string }): Promise<IngestUrlsOutcome> {
	if (!args.userId) {
		return { ok: false, code: 'UNAUTHORIZED', message: 'userId is required' };
	}
	if (args.urls.length === 0) {
		return { ok: false, code: 'BAD_REQUEST', message: 'Missing url or urls field' };
	}
	if (args.urls.length > INGEST_MAX_BATCH_SIZE) {
		return {
			ok: false,
			code: 'BATCH_TOO_LARGE',
			message: `Maximum ${INGEST_MAX_BATCH_SIZE} URLs per request, got ${args.urls.length}`,
		};
	}

	const { success } = await env.USER_INGEST_LIMITER.limit({ key: `user:${args.userId}` });
	if (!success) {
		return { ok: false, code: 'RATE_LIMITED', message: 'Too many ingest requests; retry shortly.' };
	}

	const normalizedUrls = args.urls.map(normalizeUrl);
	const uniqueUrls = [...new Set(normalizedUrls)];

	logInfo('INGEST', 'Processing URLs', { count: args.urls.length, uniqueCount: uniqueUrls.length, userId: args.userId });
	const userId = args.userId;
	const uniqueResults: IngestResult[] = [];
	for (let i = 0; i < uniqueUrls.length; i += INGEST_URL_CONCURRENCY) {
		const batch = uniqueUrls.slice(i, i + INGEST_URL_CONCURRENCY);
		uniqueResults.push(...(await Promise.all(batch.map((url) => processUrl(url, env, userId)))));
	}
	const resultByUrl = new Map(uniqueResults.map((result) => [result.url, result]));
	const results = normalizedUrls.map((url) => resultByUrl.get(url) ?? { url, error: 'lost during fan-out' });
	return { ok: true, results };
}
