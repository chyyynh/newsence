import { createDbClient, insertUserFile, USER_FILES_TABLE, upsertYoutubeTranscript } from '../../infra/db';
import { logError, logInfo } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import { parsePlatformMetadata } from '../../models/platform-metadata-parser';
import { detectPlatformType, type ScrapedContent } from '../../models/scraped-content';
import type { Env } from '../../models/types';
import { scrapeUrl } from '../../platforms/registry';
import { DEFAULT_SUBMIT_RATE_LIMIT_MAX, DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC, hitSubmitRateLimit } from '../middleware/rate-limit';
import { createUserFileWorkflow } from '../workflows/article-workflow-client';

const EXIST_COLS = 'id, title, title_cn, summary_cn, tags, platform_type, og_image_url';
const SUBMIT_MAX_BATCH_SIZE = 20;
type ExistingUserFileRow = {
	id: string;
	title: string;
	title_cn: string | null;
	summary_cn: string | null;
	tags: string[] | null;
	platform_type: string | null;
	og_image_url: string | null;
};

export type SubmitResult = {
	url: string;
	userFileId?: string;
	instanceId?: string;
	title?: string;
	titleCn?: string;
	summaryCn?: string;
	tags?: string[];
	ogImageUrl?: string | null;
	resourceKind?: 'url';
	originType?: 'saved_url';
	platformType?: string;
	alreadyExists?: boolean;
	error?: string;
};

export type SubmitErrorCode = 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED';
export type SubmitOutcome =
	| { ok: true; results: SubmitResult[] }
	| { ok: false; code: SubmitErrorCode; message: string; retryAfterSec?: number };

export type SubmitArgs = {
	urls: string[];
	userId?: string;
	visibility?: 'public' | 'private';
	rateKey: string;
};

async function scrapeAndInsert(
	url: string,
	env: Env,
	userId: string,
	visibility: 'public' | 'private',
): Promise<
	| { userFileId: string; scraped: ScrapedContent; platformType: string; created: true }
	| { userFileId: string; existing: ExistingUserFileRow; platformType: string; created: false }
	| { error: string }
> {
	const platformType = detectPlatformType(url);
	const scraped = await scrapeUrl(url, {
		youtubeApiKey: env.YOUTUBE_API_KEY,
		kaitoApiKey: env.KAITO_API_KEY,
	});

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
			visibility,
		});

		if (!userFile) {
			logError('SUBMIT', 'DB insert failed', { url, error: 'No id returned' });
			return { error: 'DB insert failed' };
		}

		if (!userFile.created) {
			return { userFileId: userFile.id, existing: userFile, platformType: userFile.platform_type || platformType, created: false };
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
		return { userFileId: userFile.id, scraped, platformType, created: true };
	} catch (err) {
		logError('SUBMIT', 'DB insert failed', { url, error: String(err) });
		return { error: 'DB insert failed' };
	} finally {
		await db.end();
	}
}

async function returnExisting(url: string, row: ExistingUserFileRow, env: Env): Promise<SubmitResult> {
	const platformType = row.platform_type || 'web';
	const instanceId = row.title_cn ? undefined : await createUserFileWorkflow(env, row.id, platformType);
	return {
		url,
		userFileId: row.id,
		instanceId,
		resourceKind: 'url',
		originType: 'saved_url',
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags ? (Array.isArray(row.tags) ? row.tags : []) : undefined,
		ogImageUrl: row.og_image_url,
		platformType,
		alreadyExists: true,
	};
}

function returnExistingWithoutWorkflow(url: string, row: ExistingUserFileRow): SubmitResult {
	const platformType = row.platform_type || 'web';
	return {
		url,
		userFileId: row.id,
		resourceKind: 'url',
		originType: 'saved_url',
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags ? (Array.isArray(row.tags) ? row.tags : []) : undefined,
		ogImageUrl: row.og_image_url,
		platformType,
		alreadyExists: true,
	};
}

export async function processUrl(
	rawUrl: string,
	env: Env,
	userId: string,
	visibility: 'public' | 'private' = 'private',
): Promise<SubmitResult> {
	const url = normalizeUrl(rawUrl);

	const db = await createDbClient(env);
	try {
		const existing = await db.query<ExistingUserFileRow>(
			`SELECT ${EXIST_COLS} FROM ${USER_FILES_TABLE}
			 WHERE user_id = $1
			   AND resource_kind = 'url'
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

	let result: Awaited<ReturnType<typeof scrapeAndInsert>>;
	try {
		result = await scrapeAndInsert(url, env, userId, visibility);
	} catch (err) {
		logError('SUBMIT', 'Scrape failed', { url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };
	if (!result.created) return returnExistingWithoutWorkflow(url, result.existing);

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

export async function submitUrls(env: Env, args: SubmitArgs): Promise<SubmitOutcome> {
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
	const visibility = args.visibility ?? 'private';
	const userId = args.userId;
	const uniqueResults = await Promise.all(uniqueUrls.map((url) => processUrl(url, env, userId, visibility)));
	const resultByUrl = new Map(uniqueResults.map((result) => [result.url, result]));
	const results = normalizedUrls.map((url) => resultByUrl.get(url) ?? { url, error: 'URL processing failed' });
	return { ok: true, results };
}
