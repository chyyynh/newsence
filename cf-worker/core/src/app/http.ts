import { detectPlatformType, type ScrapedContent, scrapeUrl, scrapeWebPage } from '../domain/scrapers';
import { ARTICLES_TABLE, createDbClient } from '../infra/db';
import { logError, logInfo, logWarn } from '../infra/log';
import { normalizeUrl } from '../infra/web';
import type { PlatformMetadata } from '../models/platform-metadata';
import {
	buildDefault,
	buildHackerNews,
	buildTwitterArticle,
	buildTwitterShared,
	buildTwitterStandard,
	buildYouTube,
} from '../models/platform-metadata';
import type { Env } from '../models/types';

const DEFAULT_SUBMIT_RATE_LIMIT_MAX = 20;
const DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC = 60;

type RateBucket = { count: number; resetAt: number };
const submitRateBuckets = new Map<string, RateBucket>();

function getInternalToken(request: Request): string | null {
	return request.headers.get('x-internal-token') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(a)),
		crypto.subtle.digest('SHA-256', encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(hashA, hashB);
}

async function isSubmitAuthorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) return true; // Backward-compatible when token is not configured yet
	const provided = getInternalToken(request)?.trim();
	if (!provided) return false;
	return timingSafeEqual(provided, expected);
}

async function isTelegramAuthorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) {
		logWarn('TELEGRAM', 'CORE_WORKER_INTERNAL_TOKEN is not configured; denying request');
		return false;
	}
	const provided = getInternalToken(request)?.trim();
	if (!provided) return false;
	return timingSafeEqual(provided, expected);
}

function getSubmitRateKey(request: Request, userId?: string): string {
	const normalizedUserId = userId?.trim();
	if (normalizedUserId) return `user:${normalizedUserId}`;
	const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	return ip ? `ip:${ip}` : 'anon';
}

function pruneExpiredBuckets(): void {
	const now = Date.now();
	for (const [key, bucket] of submitRateBuckets) {
		if (bucket.resetAt <= now) submitRateBuckets.delete(key);
	}
}

function hitSubmitRateLimit(key: string, max: number, windowSec: number, cost = 1): { limited: boolean; retryAfterSec: number } {
	const now = Date.now();
	const windowMs = Math.max(windowSec, 1) * 1000;
	if (submitRateBuckets.size > 1000) pruneExpiredBuckets();
	const existing = submitRateBuckets.get(key);

	if (!existing || existing.resetAt <= now) {
		if (cost > max) {
			const retryAfterSec = existing ? Math.max(Math.ceil((existing.resetAt - now) / 1000), 1) : Math.max(windowSec, 1);
			return { limited: true, retryAfterSec };
		}
		submitRateBuckets.set(key, { count: cost, resetAt: now + windowMs });
		return { limited: false, retryAfterSec: 0 };
	}

	if (existing.count + cost > max) {
		return { limited: true, retryAfterSec: Math.max(Math.ceil((existing.resetAt - now) / 1000), 1) };
	}

	existing.count += cost;
	submitRateBuckets.set(key, existing);
	return { limited: false, retryAfterSec: 0 };
}

// ─────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────

export function handleHealth(_env: Env): Response {
	return Response.json({
		status: 'ok',
		worker: 'newsence-core',
		timestamp: new Date().toISOString(),
	});
}

// ─────────────────────────────────────────────────────────────
// Test Scrape (compare cheerio vs Playwright)
// ─────────────────────────────────────────────────────────────

export async function handleTestScrape(request: Request, env: Env): Promise<Response> {
	if (!(await isSubmitAuthorized(request, env))) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const reqUrl = new URL(request.url);
	const url = reqUrl.searchParams.get('url');
	if (!url) return Response.json({ error: 'Missing ?url= parameter' }, { status: 400 });

	const start = Date.now();
	try {
		const r = await scrapeWebPage(url, env);
		return Response.json({
			url,
			results: { crawl: { chars: r.content.length, title: r.title, content: r.content, ms: Date.now() - start } },
		});
	} catch (e) {
		return Response.json({ url, results: { crawl: { error: String(e) } } });
	}
}

// ─────────────────────────────────────────────────────────────
// Submit URL (supports both fast and full processing modes)
// ─────────────────────────────────────────────────────────────

type SubmitBody = {
	url?: string; // Legacy single URL (backward compatible)
	urls?: string[]; // Batch URLs
	userId?: string;
};

type SubmitResult = {
	url: string;
	articleId?: string;
	instanceId?: string;
	title?: string;
	ogImageUrl?: string | null;
	sourceType?: string;
	alreadyExists?: boolean;
	error?: string;
};

async function createWorkflow(env: Env, articleId: string, sourceType: string): Promise<string | undefined> {
	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			params: { article_id: articleId, source_type: sourceType },
		});
		return instance.id;
	} catch (err) {
		logError('SUBMIT', 'Workflow create failed', { articleId, error: String(err) });
		return undefined;
	}
}

async function scrapeAndInsert(
	url: string,
	env: Env,
	submitterId?: string,
): Promise<{ articleId: string; scraped: ScrapedContent; platformType: string } | { error: string }> {
	const platformType = detectPlatformType(url);
	const scraped = await scrapeUrl(url, {
		env,
		youtubeApiKey: env.YOUTUBE_API_KEY,
		clipApiUrl: env.CLIP_API_URL,
		clipApiSecret: env.CLIP_API_SECRET,
		kaitoApiKey: env.KAITO_API_KEY,
	});

	const skipContentCheck = platformType === 'youtube' || platformType === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return { error: 'Content too short' };
	}

	const db = await createDbClient(env);
	try {
		const table = ARTICLES_TABLE;
		const normalizedPlatformMetadata = normalizePlatformMetadata(scraped.metadata, platformType);
		const insertResult = await db.query(
			`INSERT INTO ${table}
				(url, title, source, published_date, scraped_date, summary, source_type, content, og_image_url, keywords, tags, tokens, platform_metadata, submitter_id, visibility)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
			RETURNING id`,
			[
				url,
				scraped.title,
				scraped.siteName || 'External',
				scraped.publishedDate || new Date().toISOString(),
				new Date().toISOString(),
				scraped.summary || '',
				platformType,
				scraped.content || null,
				scraped.ogImageUrl || null,
				[],
				[],
				[],
				normalizedPlatformMetadata ? JSON.stringify(normalizedPlatformMetadata) : null,
				submitterId || null,
				submitterId ? 'private' : 'public',
			],
		);

		const inserted = insertResult.rows;
		if (!inserted?.[0]?.id) {
			logError('SUBMIT', 'DB insert failed', { url, error: 'No id returned' });
			return { error: 'DB insert failed' };
		}

		// Save YouTube transcript to dedicated table (after article insert so no orphans)
		if (scraped.youtubeTranscript) {
			const yt = scraped.youtubeTranscript;
			try {
				await db.query(
					`INSERT INTO youtube_transcripts (video_id, transcript, language, chapters, chapters_from_description, fetched_at)
					VALUES ($1, $2, $3, $4, $5, $6)
					ON CONFLICT (video_id) DO UPDATE SET
						transcript = EXCLUDED.transcript,
						language = EXCLUDED.language,
						chapters = EXCLUDED.chapters,
						chapters_from_description = EXCLUDED.chapters_from_description,
						fetched_at = EXCLUDED.fetched_at`,
					[
						yt.videoId,
						JSON.stringify(yt.segments),
						yt.language,
						yt.chapters ? JSON.stringify(yt.chapters) : null,
						yt.chaptersFromDescription,
						new Date().toISOString(),
					],
				);
			} catch (transcriptErr) {
				logError('YOUTUBE', 'Failed to save transcript', { videoId: yt.videoId, error: String(transcriptErr) });
			}
		}

		logInfo('SUBMIT', 'Saved raw article', { title: scraped.title.slice(0, 50) });
		return { articleId: inserted[0].id, scraped, platformType };
	} catch (err) {
		logError('SUBMIT', 'DB insert failed', { url, error: String(err) });
		return { error: 'DB insert failed' };
	} finally {
		await db.end();
	}
}

/**
 * URL processing: scrape + DB insert + create Workflow (no waiting for AI)
 * Returns immediately with articleId + instanceId, AI processing happens in background via Workflow
 */
async function processUrl(rawUrl: string, env: Env, submitterId?: string): Promise<SubmitResult> {
	const url = normalizeUrl(rawUrl);
	const db = await createDbClient(env);
	try {
		const table = ARTICLES_TABLE;

		// 1. Check if already exists (prefer own article, then any public article)
		const existingResult = await db.query(
			`SELECT id, title, title_cn, source_type, og_image_url, visibility, submitter_id FROM ${table} WHERE url = $1`,
			[url],
		);
		const existingRows = existingResult.rows;
		if (existingRows && existingRows.length > 0) {
			// Prefer submitter's own article first, then any public one, then any row (avoids unique constraint violation)
			const existing =
				(submitterId && existingRows.find((r: Record<string, unknown>) => r.submitter_id === submitterId)) ||
				existingRows.find((r: Record<string, unknown>) => r.visibility !== 'private') ||
				existingRows[0];
			const instanceId = existing.title_cn ? undefined : await createWorkflow(env, existing.id, existing.source_type || 'article');
			if (!existing.title_cn) logInfo('SUBMIT', 'Re-creating workflow for unprocessed article', { id: existing.id });
			return {
				url,
				articleId: existing.id,
				instanceId,
				title: existing.title,
				ogImageUrl: existing.og_image_url,
				sourceType: existing.source_type,
				alreadyExists: true,
			};
		}
	} finally {
		await db.end();
	}

	// 2. Scrape + insert
	let result: Awaited<ReturnType<typeof scrapeAndInsert>>;
	try {
		result = await scrapeAndInsert(url, env, submitterId);
	} catch (err) {
		logError('SUBMIT', 'Scrape failed', { url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };

	// 3. Create workflow for background AI processing
	const instanceId = await createWorkflow(env, result.articleId, result.platformType);
	return {
		url,
		articleId: result.articleId,
		instanceId,
		title: result.scraped.title,
		ogImageUrl: result.scraped.ogImageUrl || null,
		sourceType: result.platformType,
		alreadyExists: false,
	};
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

	// Support both legacy `url` and new `urls` format
	const urls = body.urls ?? (body.url ? [body.url] : []);
	if (urls.length === 0) {
		return Response.json({ error: 'Missing url or urls field' }, { status: 400 });
	}

	const MAX_BATCH_SIZE = 20;
	if (urls.length > MAX_BATCH_SIZE) {
		return Response.json(
			{
				success: false,
				error: { code: 'BATCH_TOO_LARGE', message: `Maximum ${MAX_BATCH_SIZE} URLs per request, got ${urls.length}` },
			},
			{ status: 400 },
		);
	}

	const max = Number.parseInt(env.SUBMIT_RATE_LIMIT_MAX || '', 10) || DEFAULT_SUBMIT_RATE_LIMIT_MAX;
	const windowSec = Number.parseInt(env.SUBMIT_RATE_LIMIT_WINDOW_SEC || '', 10) || DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC;
	const rateKey = getSubmitRateKey(request, body.userId);
	const rateResult = hitSubmitRateLimit(rateKey, Math.max(max, 1), Math.max(windowSec, 1), urls.length);
	if (rateResult.limited) {
		return Response.json(
			{
				success: false,
				error: { code: 'RATE_LIMITED', message: `Too many submit requests. Retry in ${rateResult.retryAfterSec}s` },
			},
			{ status: 429, headers: { 'Retry-After': String(rateResult.retryAfterSec) } },
		);
	}

	logInfo('SUBMIT', 'Processing URLs', { count: urls.length });
	const submitterId = body.userId;
	const results = await Promise.all(urls.map((url) => processUrl(url, env, submitterId)));
	return Response.json({ success: true, results });
}

// ─────────────────────────────────────────────────────────────
// Workflow status / stream
// ─────────────────────────────────────────────────────────────

const ARTICLE_FIELDS =
	'id, title, title_cn, summary, summary_cn, content_cn, source, source_type, og_image_url, published_date, tags, keywords, url';

export async function handleWorkflowStatus(instanceId: string, env: Env): Promise<Response> {
	try {
		const instance = await env.MONITOR_WORKFLOW.get(instanceId);
		const { status, output, error } = await instance.status();

		if (status === 'complete') {
			const articleId = (output as Record<string, unknown> | undefined)?.article_id as string | undefined;
			if (articleId) {
				const db = await createDbClient(env);
				try {
					const table = ARTICLES_TABLE;
					const result = await db.query(`SELECT ${ARTICLE_FIELDS} FROM ${table} WHERE id = $1`, [articleId]);
					const article = result.rows[0];
					return Response.json({ status: 'complete', article });
				} finally {
					await db.end();
				}
			}
			return Response.json({ status: 'complete' });
		}

		return Response.json({ status, error });
	} catch (err) {
		logError('WORKFLOW-STATUS', 'Failed to get workflow status', { instanceId, error: String(err) });
		return Response.json({ status: 'error', error: String(err) }, { status: 404 });
	}
}

export async function handleWorkflowStream(instanceId: string, env: Env): Promise<Response> {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	const writeEvent = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

	(async () => {
		try {
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 3000));

				const instance = await env.MONITOR_WORKFLOW.get(instanceId);
				const { status, output, error } = await instance.status();
				const isTerminal = status === 'complete' || status === 'errored' || status === 'terminated';

				if (status === 'complete') {
					const articleId = (output as Record<string, unknown> | undefined)?.article_id as string | undefined;
					if (articleId) {
						const db = await createDbClient(env);
						try {
							const table = ARTICLES_TABLE;
							const result = await db.query(`SELECT ${ARTICLE_FIELDS} FROM ${table} WHERE id = $1`, [articleId]);
							const article = result.rows[0];
							await writeEvent({ status: 'complete', article });
						} finally {
							await db.end();
						}
					} else {
						await writeEvent({ status: 'complete' });
					}
					return;
				}

				await writeEvent({ status, error });
				if (isTerminal) return;
			}
		} catch (err) {
			await writeEvent({ status: 'error', error: String(err) });
		} finally {
			await writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}

// ─────────────────────────────────────────────────────────────
// Telegram account lookup
// ─────────────────────────────────────────────────────────────

export async function handleTelegramLookup(request: Request, env: Env): Promise<Response> {
	if (!(await isTelegramAuthorized(request, env))) {
		return Response.json({ found: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: { telegramId?: string };
	try {
		body = (await request.json()) as { telegramId?: string };
	} catch {
		return Response.json({ found: false, error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.telegramId) {
		return Response.json({ found: false, error: 'Missing telegramId' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		const result = await db.query(`SELECT "userId" FROM account WHERE "providerId" = $1 AND "accountId" = $2`, [
			'telegram',
			body.telegramId,
		]);
		const data = result.rows[0];

		if (!data) return Response.json({ found: false });
		return Response.json({ found: true, userId: data.userId });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Telegram: fetch user collections
// ─────────────────────────────────────────────────────────────

export async function handleTelegramCollections(request: Request, env: Env): Promise<Response> {
	if (!(await isTelegramAuthorized(request, env))) {
		return Response.json({ collections: [], error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string };
	try {
		body = (await request.json()) as { userId?: string };
	} catch {
		return Response.json({ collections: [], error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.userId) {
		return Response.json({ collections: [], error: 'Missing userId' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		const result = await db.query(
			`SELECT id, name, icon, is_default, is_system
			FROM collections
			WHERE user_id = $1
			ORDER BY is_system DESC, is_default DESC, updated_at DESC
			LIMIT 10`,
			[body.userId],
		);

		const collections = (result.rows ?? []).map((c: Record<string, unknown>) => ({
			id: c.id,
			name: c.name,
			icon: c.icon,
			isDefault: c.is_default,
			isSystem: c.is_system,
		}));

		return Response.json({ collections });
	} catch (err) {
		logError('TELEGRAM', 'Collections query error', { error: String(err) });
		return Response.json({ collections: [] });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Telegram: add article to collection
// ─────────────────────────────────────────────────────────────

export async function handleTelegramAddToCollection(request: Request, env: Env): Promise<Response> {
	if (!(await isTelegramAuthorized(request, env))) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string; articleId?: string; collectionId?: string };
	try {
		body = (await request.json()) as { userId?: string; articleId?: string; collectionId?: string };
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
	}

	const { userId, articleId, collectionId } = body;
	if (!userId || !articleId || !collectionId) {
		return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		// Ensure the target collection belongs to the requesting user.
		const collectionResult = await db.query(`SELECT id FROM collections WHERE id = $1 AND user_id = $2`, [collectionId, userId]);
		const ownedCollection = collectionResult.rows[0] ?? null;

		if (!ownedCollection) {
			return Response.json({ success: false, error: 'Invalid collection for user' }, { status: 403 });
		}

		// Verify article exists
		const table = ARTICLES_TABLE;
		const articleResult = await db.query(`SELECT id FROM ${table} WHERE id = $1`, [articleId]);
		const articleExists = articleResult.rows[0] ?? null;
		if (!articleExists) {
			return Response.json({ success: false, error: 'Article not found' }, { status: 404 });
		}

		// Check if already exists
		const existingResult = await db.query(
			`SELECT id FROM citations WHERE from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4 AND user_id = $5`,
			['collection', collectionId, 'article', articleId, userId],
		);
		const existing = existingResult.rows[0];

		if (existing) {
			return Response.json({ success: false, error: 'already_exists' });
		}

		// Insert citation
		await db.query(
			`INSERT INTO citations (from_type, from_id, to_type, to_id, relation_type, user_id)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			['collection', collectionId, 'article', articleId, 'resource', userId],
		);

		// Increment article_count (non-atomic read-then-update; acceptable for low-throughput Telegram endpoint)
		const colResult = await db.query(`SELECT article_count FROM collections WHERE id = $1 AND user_id = $2`, [collectionId, userId]);
		const col = colResult.rows[0];
		if (col) {
			await db.query(`UPDATE collections SET article_count = $1 WHERE id = $2 AND user_id = $3`, [
				(col.article_count ?? 0) + 1,
				collectionId,
				userId,
			]);
		}

		return Response.json({ success: true });
	} catch (err) {
		logError('TELEGRAM', 'Add to collection failed', { error: String(err) });
		return Response.json({ success: false, error: 'Insert failed' }, { status: 500 });
	} finally {
		await db.end();
	}
}

function normalizePlatformMetadata(metadata: Record<string, unknown> | undefined, fallbackType: string): PlatformMetadata | null {
	if (!metadata) return null;
	const rawType = metadata.type;
	const type = typeof rawType === 'string' && rawType.trim().length > 0 ? rawType : fallbackType;

	switch (type) {
		case 'youtube':
			return buildYouTube({
				videoId: (metadata.videoId as string) || '',
				channelName: (metadata.channelName as string) || '',
				channelId: metadata.channelId as string | undefined,
				channelAvatar: metadata.channelAvatar as string | undefined,
				duration: metadata.duration as string | undefined,
				thumbnailUrl: metadata.thumbnailUrl as string | undefined,
				viewCount: metadata.viewCount as number | undefined,
				likeCount: metadata.likeCount as number | undefined,
				commentCount: metadata.commentCount as number | undefined,
				publishedAt: metadata.publishedAt as string | undefined,
				description: metadata.description as string | undefined,
				tags: metadata.tags as string[] | undefined,
			});
		case 'hackernews':
			return buildHackerNews({
				itemId: (metadata.itemId as string) || '',
				author: (metadata.author as string) || '',
				points: (metadata.points as number) || 0,
				commentCount: (metadata.commentCount as number) || 0,
				itemType: metadata.itemType as 'story' | 'ask' | 'show' | 'job' | undefined,
				storyUrl: metadata.storyUrl as string | null | undefined,
			});
		case 'twitter': {
			const author = {
				authorName: (metadata.authorName as string) || '',
				authorUserName: (metadata.authorUserName as string) || '',
				authorProfilePicture: metadata.authorProfilePicture as string | undefined,
				authorVerified: metadata.authorVerified as boolean | undefined,
			};
			const variant = metadata.variant as string | undefined;
			if (variant === 'shared') {
				return buildTwitterShared(author, {
					tweetId: metadata.tweetId as string | undefined,
					media: (metadata.media as Array<{ url: string; type: 'photo' | 'video' | 'animated_gif' }>) || [],
					createdAt: metadata.createdAt as string | undefined,
					tweetText: metadata.tweetText as string | undefined,
					externalUrl: (metadata.externalUrl as string) || '',
					externalOgImage: metadata.externalOgImage as string | null | undefined,
					externalTitle: metadata.externalTitle as string | null | undefined,
					originalTweetUrl: metadata.originalTweetUrl as string | undefined,
				});
			}
			if (variant === 'article') {
				return buildTwitterArticle(author, metadata.tweetId as string | undefined);
			}
			return buildTwitterStandard(author, {
				tweetId: metadata.tweetId as string | undefined,
				media: (metadata.media as Array<{ url: string; type: 'photo' | 'video' | 'animated_gif' }>) || [],
				createdAt: metadata.createdAt as string | undefined,
			});
		}
		default:
			return buildDefault();
	}
}
