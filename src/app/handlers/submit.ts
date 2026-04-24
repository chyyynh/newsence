import { detectPlatformType, type ScrapedContent, scrapeUrl } from '../../domain/scrapers';
import { createDbClient, insertUserFile, USER_FILES_TABLE, upsertYoutubeTranscript } from '../../infra/db';
import { logError, logInfo } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import { parsePlatformMetadata } from '../../models/platform-metadata-parser';
import type { Env } from '../../models/types';
import { isSubmitAuthorized } from '../middleware/auth';
import {
	DEFAULT_SUBMIT_RATE_LIMIT_MAX,
	DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC,
	getSubmitRateKey,
	hitSubmitRateLimit,
} from '../middleware/rate-limit';

const EXIST_COLS = 'id, title, title_cn, summary_cn, tags, platform_type, og_image_url';

type SubmitBody = {
	url?: string; // Legacy single URL
	urls?: string[]; // Batch URLs
	userId?: string;
	visibility?: 'public' | 'private';
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

async function createWorkflow(env: Env, userFileId: string, platformType: string): Promise<string | undefined> {
	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			params: {
				article_id: userFileId,
				source_type: platformType,
				target_table: USER_FILES_TABLE,
			},
		});
		return instance.id;
	} catch (err) {
		logError('SUBMIT', 'Workflow create failed', { userFileId, error: String(err) });
		return undefined;
	}
}

async function scrapeAndInsert(
	url: string,
	env: Env,
	userId: string,
	visibility: 'public' | 'private',
): Promise<{ userFileId: string; scraped: ScrapedContent; platformType: string } | { error: string }> {
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

		const userFileId = await insertUserFile(db, {
			url,
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

		if (!userFileId) {
			logError('SUBMIT', 'DB insert failed', { url, error: 'No id returned' });
			return { error: 'DB insert failed' };
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

		logInfo('SUBMIT', 'Saved user_file', { title: scraped.title.slice(0, 50), userFileId });
		return { userFileId, scraped, platformType };
	} catch (err) {
		logError('SUBMIT', 'DB insert failed', { url, error: String(err) });
		return { error: 'DB insert failed' };
	} finally {
		await db.end();
	}
}

async function returnExisting(url: string, row: Record<string, string>, env: Env): Promise<SubmitResult> {
	// Row already exists for this user — if unprocessed, kick off the workflow.
	const platformType = row.platform_type || 'web';
	const instanceId = row.title_cn ? undefined : await createWorkflow(env, row.id, platformType);
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

/**
 * URL ingest: scrape + insert into user_files + kick off AI enrichment workflow.
 * Returns immediately; AI processing happens in background via the Workflow.
 *
 * Requires `userId`. There is no anonymous path — all scraped URLs land in a
 * per-user `user_files` row. The frontend is responsible for citation
 * creation (workspace/document/collection link) after receiving userFileId.
 */
export async function processUrl(
	rawUrl: string,
	env: Env,
	userId: string,
	visibility: 'public' | 'private' = 'private',
): Promise<SubmitResult> {
	const url = normalizeUrl(rawUrl);

	// Dedup per user: reuse the existing user_file row if the user already has
	// this URL saved.
	const db = await createDbClient(env);
	try {
		const existing = await db.query(`SELECT ${EXIST_COLS} FROM ${USER_FILES_TABLE} WHERE user_id = $1 AND source_url = $2 LIMIT 1`, [
			userId,
			url,
		]);
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

	const instanceId = await createWorkflow(env, result.userFileId, result.platformType);
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

// ── Pure submitUrls action (RPC + HTTP entry points share this) ──

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

const SUBMIT_MAX_BATCH_SIZE = 20;

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

	logInfo('SUBMIT', 'Processing URLs', { count: args.urls.length, userId: args.userId });
	const visibility = args.visibility ?? 'private';
	const userId = args.userId;
	const results = await Promise.all(args.urls.map((url) => processUrl(url, env, userId, visibility)));
	return { ok: true, results };
}

export async function handleSubmitUrl(request: Request, env: Env): Promise<Response> {
	if (!(await isSubmitAuthorized(request, env))) {
		return Response.json(
			{ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' } },
			{ status: 401 },
		);
	}

	let body: SubmitBody;
	try {
		body = (await request.json()) as SubmitBody;
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const urls = body.urls ?? (body.url ? [body.url] : []);
	const outcome = await submitUrls(env, {
		urls,
		userId: body.userId,
		visibility: body.visibility,
		rateKey: getSubmitRateKey(request, body.userId),
	});
	if (outcome.ok) return Response.json({ success: true, results: outcome.results });

	if (outcome.code === 'RATE_LIMITED') {
		return Response.json(
			{ success: false, error: { code: outcome.code, message: outcome.message } },
			{ status: 429, headers: { 'Retry-After': String(outcome.retryAfterSec ?? 1) } },
		);
	}
	const status = outcome.code === 'UNAUTHORIZED' ? 401 : 400;
	return Response.json({ success: false, error: { code: outcome.code, message: outcome.message } }, { status });
}
