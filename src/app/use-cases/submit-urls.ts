import { createDbClient, insertBlobUserFile, insertUserFile, USER_FILES_TABLE, upsertYoutubeTranscript } from '../../infra/db';
import { logError, logInfo } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import { parsePlatformMetadata } from '../../models/platform-metadata-parser';
import { detectPlatformType, type ScrapedContent } from '../../models/scraped-content';
import type { Env } from '../../models/types';
import { type ScrapeResult, scrapeUrl } from '../../platforms/registry';
import { DEFAULT_SUBMIT_RATE_LIMIT_MAX, DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC, hitSubmitRateLimit } from '../middleware/rate-limit';
import { createUserFileWorkflow } from '../workflows/article-workflow-client';

const EXIST_COLS = 'id, title, title_cn, summary_cn, tags, platform_type, og_image_url, resource_kind, origin_type';
const SUBMIT_MAX_BATCH_SIZE = 20;
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
	origin_type: string;
};

type SubmitResult = {
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

type SubmitErrorCode = 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED';
export type SubmitOutcome =
	| { ok: true; results: SubmitResult[] }
	| { ok: false; code: SubmitErrorCode; message: string; retryAfterSec?: number };

function extensionFromMime(contentType: string, fileName: string): string {
	const fromName = fileName.split('.').pop()?.toLowerCase();
	if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
	const subtype = contentType.split('/')[1]?.split(';')[0]?.split('+')[0]?.trim() ?? 'bin';
	return subtype === 'jpeg' ? 'jpg' : subtype;
}

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
			pdfUrl: `/api/r2/${args.storageKey}`,
		},
	};
}

type InsertOutcome =
	| { kind: 'page'; userFileId: string; scraped: ScrapedContent; platformType: string; created: true }
	| { kind: 'page-existing'; userFileId: string; existing: ExistingUserFileRow; platformType: string; created: false }
	| { kind: 'blob'; userFileId: string; fileType: string; sourceUrl: string; created: true }
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
			logError('SUBMIT', 'DB insert failed', { url, error: 'No id returned' });
			return { error: 'DB insert failed' };
		}

		if (!userFile.created) {
			return {
				kind: 'page-existing',
				userFileId: userFile.id,
				existing: { ...userFile, resource_kind: 'url', origin_type: 'saved_url' },
				platformType: userFile.platform_type || platformType,
				created: false,
			};
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

		logInfo('SUBMIT', 'Saved user_file', { title: scraped.title.slice(0, 50), userFileId: userFile.id });
		return { kind: 'page', userFileId: userFile.id, scraped, platformType, created: true };
	} catch (err) {
		logError('SUBMIT', 'DB insert failed', { url, error: String(err) });
		return { error: 'DB insert failed' };
	} finally {
		await db.end();
	}
}

async function insertScrapedBlob(
	blob: Extract<ScrapeResult, { kind: 'blob' }>,
	url: string,
	env: Env,
	userId: string,
): Promise<InsertOutcome> {
	const ext = extensionFromMime(blob.contentType, blob.suggestedFilename);
	const storageKey = `users/${userId}/uploads/${crypto.randomUUID()}.${ext}`;

	try {
		await env.R2.put(storageKey, blob.bytes, {
			httpMetadata: { contentType: blob.contentType, cacheControl: 'private, max-age=31536000' },
		});
	} catch (err) {
		logError('SUBMIT', 'R2 put failed', { url, storageKey, error: String(err) });
		return { error: 'R2 put failed' };
	}

	const title = deriveTitle(blob.suggestedFilename, blob.contentType);
	const metadata =
		blob.contentType === PDF_MIME
			? buildPdfMetadata({ fileName: blob.suggestedFilename, fileSize: blob.bytes.byteLength, storageKey })
			: null;

	const db = await createDbClient(env);
	try {
		const row = await insertBlobUserFile(db, {
			userId,
			storageKey,
			fileSize: blob.bytes.byteLength,
			fileType: blob.contentType,
			fileName: blob.suggestedFilename,
			originType: 'saved_url',
			title,
			sourceUrl: blob.sourceUrl,
			normalizedSourceUrl: url,
			metadata,
		});
		logInfo('SUBMIT', 'Saved blob from URL', { title: title.slice(0, 50), userFileId: row.id, contentType: blob.contentType });
		return { kind: 'blob', userFileId: row.id, fileType: blob.contentType, sourceUrl: blob.sourceUrl, created: true };
	} catch (err) {
		logError('SUBMIT', 'Blob row insert failed', { url, error: String(err) });
		return { error: 'DB insert failed' };
	} finally {
		await db.end();
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

function buildExistingResult(url: string, row: ExistingUserFileRow, instanceId: string | undefined): SubmitResult {
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

async function returnExisting(url: string, row: ExistingUserFileRow, env: Env): Promise<SubmitResult> {
	const sourceTypeForWorkflow = row.resource_kind === 'blob' ? 'pdf' : row.platform_type || 'web';
	const instanceId = row.title_cn ? undefined : await createUserFileWorkflow(env, row.id, sourceTypeForWorkflow);
	return buildExistingResult(url, row, instanceId);
}

export async function processUrl(rawUrl: string, env: Env, userId: string): Promise<SubmitResult> {
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
		logError('SUBMIT', 'Scrape failed', { url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };
	if (result.kind === 'page-existing') {
		return buildExistingResult(url, result.existing, undefined);
	}

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

	const instanceId = await createUserFileWorkflow(env, result.userFileId, result.platformType);
	return {
		url,
		userFileId: result.userFileId,
		instanceId,
		resourceKind: 'url',
		originType: 'saved_url',
		title: result.scraped.title,
		ogImageUrl: result.scraped.ogImageUrl || null,
		platformType: result.platformType,
		alreadyExists: false,
	};
}

export async function submitUrls(env: Env, args: { urls: string[]; userId?: string; rateKey: string }): Promise<SubmitOutcome> {
	if (!args.userId) {
		return { ok: false, code: 'UNAUTHORIZED', message: 'userId is required' };
	}
	if (args.urls.length === 0) {
		return { ok: false, code: 'BAD_REQUEST', message: 'Missing url or urls field' };
	}
	if (args.urls.length > SUBMIT_MAX_BATCH_SIZE) {
		return {
			ok: false,
			code: 'BATCH_TOO_LARGE',
			message: `Maximum ${SUBMIT_MAX_BATCH_SIZE} URLs per request, got ${args.urls.length}`,
		};
	}

	const max = Number.parseInt(env.SUBMIT_RATE_LIMIT_MAX || '', 10) || DEFAULT_SUBMIT_RATE_LIMIT_MAX;
	const windowSec = Number.parseInt(env.SUBMIT_RATE_LIMIT_WINDOW_SEC || '', 10) || DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC;
	const rateResult = hitSubmitRateLimit(args.rateKey, Math.max(max, 1), Math.max(windowSec, 1), args.urls.length);
	if (rateResult.limited) {
		return {
			ok: false,
			code: 'RATE_LIMITED',
			message: `Too many submit requests. Retry in ${rateResult.retryAfterSec}s`,
			retryAfterSec: rateResult.retryAfterSec,
		};
	}

	const normalizedUrls = args.urls.map(normalizeUrl);
	const uniqueUrls = [...new Set(normalizedUrls)];

	logInfo('SUBMIT', 'Processing URLs', { count: args.urls.length, uniqueCount: uniqueUrls.length, userId: args.userId });
	const userId = args.userId;
	const uniqueResults = await Promise.all(uniqueUrls.map((url) => processUrl(url, env, userId)));
	const resultByUrl = new Map(uniqueResults.map((result) => [result.url, result]));
	const results = normalizedUrls.map((url) => resultByUrl.get(url) ?? { url, error: 'URL processing failed' });
	return { ok: true, results };
}
