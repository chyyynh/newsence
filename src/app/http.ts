import { detectPlatformType, type ScrapedContent, scrapeUrl, scrapeWebPage } from '../domain/scrapers';
import { ARTICLES_TABLE, createDbClient, USER_ARTICLES_TABLE } from '../infra/db';
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
import type { Env, TelegramNotifyContext } from '../models/types';

const DEFAULT_SUBMIT_RATE_LIMIT_MAX = 20;
const DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC = 60;

/**
 * Best-effort in-memory rate limiter. NOT reliable across isolates —
 * Cloudflare may route requests to different instances. Acceptable for
 * /submit which is low-traffic and auth-gated. For stricter limiting,
 * migrate to Durable Objects or KV-based counting.
 */
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

/** Validate that a user is a member of the given organization. Caller manages the db lifecycle. */
async function checkOrgMembership(db: { query: (q: string, p: unknown[]) => Promise<{ rows: unknown[] }> }, userId: string, organizationId: string): Promise<boolean> {
	const r = await db.query(
		`SELECT 1 FROM member WHERE "organizationId" = $1 AND "userId" = $2 LIMIT 1`,
		[organizationId, userId],
	);
	return r.rows.length > 0;
}

/** Standalone version — creates its own connection for entry-point validation. */
async function validateOrgMembership(env: Env, userId: string, organizationId: string): Promise<boolean> {
	const db = await createDbClient(env);
	try {
		return await checkOrgMembership(db, userId, organizationId);
	} finally {
		await db.end();
	}
}

async function isBotAuthorized(request: Request, env: Env): Promise<boolean> {
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
// Embed (replaces embedding-proxy worker)
// ─────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const EMBED_MAX_TEXT = 8000;

function normalizeEmbedding(v: number[]): number[] {
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return norm === 0 ? v : v.map((x) => x / norm);
}

export async function handleEmbed(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const body = (await request.json().catch(() => ({}))) as { text?: string; texts?: string[] };
	const input = body.texts || (body.text ? [body.text] : []);
	if (input.length === 0) {
		return Response.json({ error: 'No text provided' }, { status: 400, headers: CORS_HEADERS });
	}

	const sanitized = input.map((t) => t.trim().slice(0, EMBED_MAX_TEXT));

	try {
		const result = (await env.AI.run(EMBEDDING_MODEL as Parameters<Ai['run']>[0], { text: sanitized })) as {
			data: number[][];
		};
		return Response.json(
			{ embeddings: result.data.map(normalizeEmbedding), model: EMBEDDING_MODEL, dimensions: 1024 },
			{ headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } },
		);
	} catch (error) {
		logError('EMBED', 'Generation failed', { error: String(error) });
		return Response.json(
			{ error: 'Embedding generation failed', details: error instanceof Error ? error.message : 'Unknown error' },
			{ status: 500, headers: CORS_HEADERS },
		);
	}
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
		const r = await scrapeWebPage(url);
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
	organizationId?: string;
	visibility?: 'public' | 'private'; // For user_articles; defaults to 'public'
	notifyContext?: {
		platform: 'telegram' | 'feishu';
		chatId: string;
		messageId: string;
		linked: boolean;
		userId: string;
		webappUrl: string;
	};
};

type SubmitResult = {
	url: string;
	articleId?: string;
	instanceId?: string;
	title?: string;
	titleCn?: string;
	summaryCn?: string;
	tags?: string[];
	ogImageUrl?: string | null;
	sourceType?: string;
	alreadyExists?: boolean;
	isUserArticle?: boolean;
	error?: string;
};

async function createWorkflow(
	env: Env,
	articleId: string,
	sourceType: string,
	notifyContext?: TelegramNotifyContext,
	targetTable?: string,
): Promise<string | undefined> {
	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			params: {
				article_id: articleId,
				source_type: sourceType,
				...(notifyContext ? { notify_context: notifyContext } : {}),
				...(targetTable ? { target_table: targetTable } : {}),
			},
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
	userId?: string,
	targetTable?: string,
	visibility = 'public',
	organizationId?: string,
): Promise<{ articleId: string; scraped: ScrapedContent; platformType: string } | { error: string }> {
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
		const table = targetTable ?? ARTICLES_TABLE;
		const isUserArticle = table === USER_ARTICLES_TABLE;
		const normalizedPlatformMetadata = normalizePlatformMetadata(scraped.metadata, platformType);
		const platformMetadataJson = normalizedPlatformMetadata
			? JSON.stringify({ ...normalizedPlatformMetadata, ogImageWidth: scraped.ogImageWidth ?? null, ogImageHeight: scraped.ogImageHeight ?? null })
			: null;

		let insertResult: { rows: { id: string }[] };
		if (isUserArticle) {
			insertResult = await db.query(
				`INSERT INTO ${table}
					(url, title, source, published_date, scraped_date, summary, source_type, content, og_image_url, keywords, tags, platform_metadata, user_id, visibility, organization_id)
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
					platformMetadataJson,
					userId,
					visibility,
					organizationId || null,
				],
			);
		} else {
			insertResult = await db.query(
				`INSERT INTO ${table}
					(url, title, source, published_date, scraped_date, summary, source_type, content, og_image_url, keywords, tags, tokens, platform_metadata)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
					platformMetadataJson,
				],
			);
		}

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

		logInfo('SUBMIT', 'Saved raw article', { title: scraped.title.slice(0, 50), table });
		return { articleId: inserted[0].id, scraped, platformType };
	} catch (err) {
		logError('SUBMIT', 'DB insert failed', { url, error: String(err) });
		return { error: 'DB insert failed' };
	} finally {
		await db.end();
	}
}

/**
 * If the row is already processed (has title_cn), skip workflow. Otherwise create one.
 * Returns the existing-article SubmitResult.
 */
async function returnExisting(
	url: string,
	row: Record<string, string>,
	env: Env,
	notifyContext: Omit<TelegramNotifyContext, 'articleId' | 'alreadyExists'> | undefined,
	isUserArticle: boolean,
	targetTable?: string,
): Promise<SubmitResult> {
	const enrichedNotify = notifyContext
		? { ...notifyContext, articleId: row.id, alreadyExists: true, ...(isUserArticle ? { isUserArticle: true } : {}) }
		: undefined;
	const instanceId = row.title_cn
		? undefined
		: await createWorkflow(env, row.id, row.source_type || 'article', enrichedNotify, targetTable);
	return {
		url,
		articleId: row.id,
		instanceId,
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags ? (Array.isArray(row.tags) ? row.tags : []) : undefined,
		ogImageUrl: row.og_image_url,
		sourceType: row.source_type,
		alreadyExists: true,
		isUserArticle,
	};
}

/**
 * Copy a public article row into user_articles so it appears in all user-scoped queries (export, library, etc.).
 * Returns the new user_articles row (with EXIST_COLS) on success, or null if the copy failed / already existed.
 */
async function copyArticleToUserTable(
	db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
	articleId: string,
	userId: string,
	organizationId?: string,
	visibility = 'public',
): Promise<Record<string, string> | null> {
	const COPY_COLS = 'url, title, title_cn, source, published_date, scraped_date, keywords, tags, summary, summary_cn, source_type, content, content_cn, og_image_url, platform_metadata, embedding';
	const EXIST_COLS = 'id, title, title_cn, summary_cn, tags, source_type, og_image_url';
	try {
		const result = await db.query(
			`INSERT INTO ${USER_ARTICLES_TABLE} (${COPY_COLS}, user_id, organization_id, visibility)
			SELECT ${COPY_COLS}, $2, $3, $4
			FROM ${ARTICLES_TABLE} WHERE id = $1
			ON CONFLICT DO NOTHING
			RETURNING ${EXIST_COLS}`,
			[articleId, userId, organizationId || null, visibility],
		);
		if (result.rows[0]) return result.rows[0] as Record<string, string>;
		// ON CONFLICT — row already exists, look it up
		const lookup = organizationId
			? await db.query(
					`SELECT ${EXIST_COLS} FROM ${USER_ARTICLES_TABLE} WHERE organization_id = $1 AND url = (SELECT url FROM ${ARTICLES_TABLE} WHERE id = $2) LIMIT 1`,
					[organizationId, articleId],
				)
			: await db.query(
					`SELECT ${EXIST_COLS} FROM ${USER_ARTICLES_TABLE} WHERE user_id = $1 AND organization_id IS NULL AND url = (SELECT url FROM ${ARTICLES_TABLE} WHERE id = $2) LIMIT 1`,
					[userId, articleId],
				);
		return (lookup.rows[0] as Record<string, string>) ?? null;
	} catch (err) {
		logWarn('SUBMIT', 'Failed to copy article to user_articles', { articleId, error: String(err) });
		return null;
	}
}

/**
 * URL processing: scrape + DB insert + create Workflow (no waiting for AI)
 * Returns immediately with articleId + instanceId, AI processing happens in background via Workflow
 */
async function processUrl(
	rawUrl: string,
	env: Env,
	userId?: string,
	notifyContext?: Omit<TelegramNotifyContext, 'articleId' | 'alreadyExists'>,
	visibility = 'public',
	organizationId?: string,
): Promise<SubmitResult> {
	const url = normalizeUrl(rawUrl);
	const EXIST_COLS = 'id, title, title_cn, summary_cn, tags, source_type, og_image_url';

	// 1. Check for existing article — close connection before any addToUnsortedCollection calls
	let existingRow: Record<string, string> | null = null;
	let existingIsUserArticle = false;
	const db = await createDbClient(env);
	try {
		if (userId) {
			// Check user_articles first (exact user/org scope), then public articles
			const uaQuery = organizationId
				? `SELECT ${EXIST_COLS} FROM ${USER_ARTICLES_TABLE} WHERE organization_id = $1 AND url = $2 LIMIT 1`
				: `SELECT ${EXIST_COLS} FROM ${USER_ARTICLES_TABLE} WHERE user_id = $1 AND organization_id IS NULL AND url = $2 LIMIT 1`;
			const ua = await db.query(uaQuery, [organizationId || userId, url]);
			if (ua.rows.length > 0) {
				existingRow = ua.rows[0];
				existingIsUserArticle = true;
			} else {
				const pub = await db.query(`SELECT ${EXIST_COLS} FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [url]);
				if (pub.rows.length > 0) {
					// Public article exists — copy to user_articles so all user-scoped queries see it
					const copied = await copyArticleToUserTable(db, pub.rows[0].id, userId, organizationId, visibility);
					existingRow = copied ?? pub.rows[0];
					existingIsUserArticle = !!copied;
				}
			}
		} else {
			const existing = await db.query(`SELECT ${EXIST_COLS} FROM ${ARTICLES_TABLE} WHERE url = $1`, [url]);
			if (existing.rows.length > 0) return returnExisting(url, existing.rows[0], env, notifyContext, false);
		}
	} finally {
		await db.end();
	}

	// Handle existing article — add to unsorted (connection now closed, addToUnsortedCollection manages its own)
	if (existingRow && userId) {
		await addToUnsortedCollection(env, userId, existingRow.id, organizationId, existingIsUserArticle ? 'user_article' : 'article').catch(
			(err) => logWarn('SUBMIT', 'Failed to add existing to unsorted', { error: String(err) }),
		);
		return returnExisting(url, existingRow, env, notifyContext, existingIsUserArticle, existingIsUserArticle ? USER_ARTICLES_TABLE : undefined);
	}
	if (existingRow) {
		return returnExisting(url, existingRow, env, notifyContext, false);
	}

	// 2. Scrape + insert (user → user_articles, system → articles)
	const targetTable = userId ? USER_ARTICLES_TABLE : undefined;
	let result: Awaited<ReturnType<typeof scrapeAndInsert>>;
	try {
		result = await scrapeAndInsert(url, env, userId, targetTable, visibility, organizationId);
	} catch (err) {
		logError('SUBMIT', 'Scrape failed', { url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };

	// 3. Auto-add to unsorted collection (if user-submitted)
	if (userId) {
		try {
			await addToUnsortedCollection(env, userId, result.articleId, organizationId, userId ? 'user_article' : 'article');
		} catch (err) {
			logWarn('SUBMIT', 'Failed to add to unsorted collection', { error: String(err) });
		}
	}

	// 4. Create workflow for background AI processing
	const enrichedNotify = notifyContext
		? { ...notifyContext, articleId: result.articleId, alreadyExists: false, ...(userId ? { isUserArticle: true } : {}) }
		: undefined;
	const instanceId = await createWorkflow(env, result.articleId, result.platformType, enrichedNotify, targetTable);
	return {
		url,
		articleId: result.articleId,
		instanceId,
		title: result.scraped.title,
		ogImageUrl: result.scraped.ogImageUrl || null,
		sourceType: result.platformType,
		alreadyExists: false,
		isUserArticle: !!userId,
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
	const userId = body.userId;
	let organizationId = body.organizationId;
	// Validate org membership — reject spoofed organizationId
	if (organizationId && userId) {
		const isMember = await validateOrgMembership(env, userId, organizationId);
		if (!isMember) {
			return Response.json(
				{ success: false, error: { code: 'FORBIDDEN', message: 'User is not a member of this organization' } },
				{ status: 403 },
			);
		}
	} else if (organizationId && !userId) {
		organizationId = undefined; // org without user makes no sense
	}
	const articleVisibility = body.visibility ?? 'public';
	// Only pass notifyContext for single-URL submissions (bot sends one at a time)
	const notifyCtx = urls.length === 1 && body.notifyContext ? body.notifyContext : undefined;
	const results = await Promise.all(urls.map((url) => processUrl(url, env, userId, notifyCtx, articleVisibility, organizationId)));
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
	if (!(await isBotAuthorized(request, env))) {
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
	if (!(await isBotAuthorized(request, env))) {
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
			`SELECT id, name, icon
			FROM collections
			WHERE user_id = $1
			ORDER BY updated_at DESC
			LIMIT 10`,
			[body.userId],
		);

		const collections = (result.rows ?? []).map((c: Record<string, unknown>) => ({
			id: c.id,
			name: c.name,
			icon: c.icon,
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
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string; articleId?: string; collectionId?: string; toType?: string };
	try {
		body = (await request.json()) as { userId?: string; articleId?: string; collectionId?: string; toType?: string };
	} catch {
		return Response.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
	}

	const { userId, articleId, collectionId } = body;
	const toType = body.toType === 'user_article' ? 'user_article' : 'article';
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

		// Verify article exists in the correct table
		const lookupTable = toType === 'user_article' ? USER_ARTICLES_TABLE : ARTICLES_TABLE;
		const articleResult = await db.query(`SELECT id FROM ${lookupTable} WHERE id = $1`, [articleId]);
		const articleExists = articleResult.rows[0] ?? null;
		if (!articleExists) {
			return Response.json({ success: false, error: 'Article not found' }, { status: 404 });
		}

		// Check if already exists
		const existingResult = await db.query(
			`SELECT id FROM citations WHERE from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4 AND user_id = $5`,
			['collection', collectionId, toType, articleId, userId],
		);
		const existing = existingResult.rows[0];

		if (existing) {
			return Response.json({ success: false, error: 'already_exists' });
		}

		// Insert citation
		await db.query(
			`INSERT INTO citations (from_type, from_id, to_type, to_id, relation_type, user_id)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			['collection', collectionId, toType, articleId, 'resource', userId],
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

// ─────────────────────────────────────────────────────────────
// List articles (for bot export)
// ─────────────────────────────────────────────────────────────

export async function handleBotListArticles(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ articles: [], error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string; period?: string; organizationId?: string };
	try {
		body = (await request.json()) as { userId?: string; period?: string; organizationId?: string };
	} catch {
		return Response.json({ articles: [] }, { status: 400 });
	}

	if (!body.userId) {
		return Response.json({ articles: [], error: 'Missing userId' }, { status: 400 });
	}

	const period = body.period || 'unsorted';
	const orgId = body.organizationId || null;
	const db = await createDbClient(env);

	try {
		// Validate org membership using the same connection
		if (orgId) {
			const isMember = await checkOrgMembership(db, body.userId, orgId);
			if (!isMember) {
				return Response.json({ articles: [], error: 'Not a member of this organization' }, { status: 403 });
			}
		}

		let dateFilter = '';
		if (period === 'week') {
			dateFilter = `AND scraped_date >= NOW() - INTERVAL '7 days'`;
		}

		// Query user_articles first, then public articles
		const cols = 'title, COALESCE(title_cn, title) as display_title, url, source_type, COALESCE(tags, ARRAY[]::text[]) as tags, COALESCE(summary_cn, summary, \'\') as summary, published_date, scraped_date';

		let query: string;
		let params: unknown[];

		if (period === 'unsorted' && orgId) {
			// Unsorted = articles in the system collection for this org
			query = `SELECT ${cols} FROM ${USER_ARTICLES_TABLE} ua
				JOIN citations c ON c.to_type = 'user_article' AND c.to_id = ua.id::text
				JOIN collections col ON col.id = c.from_id AND col.is_system = true AND col.organization_id = $1
				WHERE c.from_type = 'collection' ${dateFilter}
				ORDER BY ua.scraped_date DESC LIMIT 500`;
			params = [orgId];
		} else if (period === 'unsorted') {
			query = `SELECT ${cols} FROM ${USER_ARTICLES_TABLE} ua
				JOIN citations c ON c.to_type = 'user_article' AND c.to_id = ua.id::text
				JOIN collections col ON col.id = c.from_id AND col.is_system = true AND col.user_id = $1 AND col.organization_id IS NULL
				WHERE c.from_type = 'collection' ${dateFilter}
				ORDER BY ua.scraped_date DESC LIMIT 500`;
			params = [body.userId];
		} else if (orgId) {
			query = `SELECT ${cols} FROM ${USER_ARTICLES_TABLE} WHERE organization_id = $1 ${dateFilter} ORDER BY scraped_date DESC LIMIT 500`;
			params = [orgId];
		} else {
			query = `SELECT ${cols} FROM ${USER_ARTICLES_TABLE} WHERE user_id = $1 AND organization_id IS NULL ${dateFilter} ORDER BY scraped_date DESC LIMIT 500`;
			params = [body.userId];
		}

		const result = await db.query(query, params);
		const articles = (result.rows ?? []).map((r: Record<string, unknown>) => ({
			title: (r.display_title as string) || (r.title as string) || '',
			url: (r.url as string) || '',
			sourceType: (r.source_type as string) || '',
			tags: (r.tags as string[]) || [],
			summary: (r.summary as string) || '',
			publishedDate: r.published_date ? String(r.published_date) : '',
			scrapedDate: r.scraped_date ? String(r.scraped_date) : '',
		}));

		return Response.json({ articles });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Unsorted collection helpers
// ─────────────────────────────────────────────────────────────

async function addToUnsortedCollection(env: Env, userId: string, articleId: string, organizationId?: string, toType = 'article'): Promise<void> {
	const db = await createDbClient(env);
	try {
		const orgId = organizationId || null;
		const existing = orgId
			? await db.query(`SELECT id FROM collections WHERE is_system = true AND organization_id = $1 LIMIT 1`, [orgId])
			: await db.query(`SELECT id FROM collections WHERE is_system = true AND user_id = $1 AND organization_id IS NULL LIMIT 1`, [userId]);

		let collectionId: string;
		if (existing.rows[0]) {
			collectionId = existing.rows[0].id;
		} else {
			// ON CONFLICT handles race condition (partial unique index on is_system + user/org)
			const ins = await db.query(
				`INSERT INTO collections (user_id, organization_id, name, is_system, visibility, article_count)
				VALUES ($1, $2, 'Unsorted', true, 'private', 0)
				ON CONFLICT DO NOTHING
				RETURNING id`,
				[userId, orgId],
			);
			if (ins.rows[0]) {
				collectionId = ins.rows[0].id;
			} else {
				// Race: another request created it first, re-query
				const retry = orgId
					? await db.query(`SELECT id FROM collections WHERE is_system = true AND organization_id = $1 LIMIT 1`, [orgId])
					: await db.query(`SELECT id FROM collections WHERE is_system = true AND user_id = $1 AND organization_id IS NULL LIMIT 1`, [userId]);
				if (!retry.rows[0]) return;
				collectionId = retry.rows[0].id;
			}
		}

		// Check not already in collection
		const dup = await db.query(
			`SELECT id FROM citations WHERE from_type = 'collection' AND from_id = $1 AND to_type = $2 AND to_id = $3 LIMIT 1`,
			[collectionId, toType, articleId],
		);
		if (dup.rows.length > 0) return;

		await db.query(
			`INSERT INTO citations (from_type, from_id, to_type, to_id, relation_type, user_id, organization_id) VALUES ('collection', $1, $2, $3, 'resource', $4, $5)`,
			[collectionId, toType, articleId, userId, orgId],
		);
		await db.query(`UPDATE collections SET article_count = article_count + 1 WHERE id = $1`, [collectionId]);
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Get or create unsorted (system) collection (bot endpoint)
// ─────────────────────────────────────────────────────────────

export async function handleBotGetUnsorted(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: { userId?: string; organizationId?: string };
	try {
		body = (await request.json()) as { userId?: string; organizationId?: string };
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.userId) {
		return Response.json({ error: 'Missing userId' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		const orgId = body.organizationId || null;

		if (orgId) {
			const isMember = await checkOrgMembership(db, body.userId, orgId);
			if (!isMember) {
				return Response.json({ error: 'Not a member of this organization' }, { status: 403 });
			}
		}

		const existing = orgId
			? await db.query(`SELECT id FROM collections WHERE is_system = true AND organization_id = $1 LIMIT 1`, [orgId])
			: await db.query(`SELECT id FROM collections WHERE is_system = true AND user_id = $1 AND organization_id IS NULL LIMIT 1`, [body.userId]);

		if (existing.rows[0]) {
			return Response.json({ collectionId: existing.rows[0].id });
		}

		const insertResult = await db.query(
			`INSERT INTO collections (user_id, organization_id, name, is_system, visibility, article_count)
			VALUES ($1, $2, 'Unsorted', true, 'private', 0)
			ON CONFLICT DO NOTHING
			RETURNING id`,
			[body.userId, orgId],
		);
		if (insertResult.rows[0]) {
			return Response.json({ collectionId: insertResult.rows[0].id });
		}
		// Race: re-query
		const retry = orgId
			? await db.query(`SELECT id FROM collections WHERE is_system = true AND organization_id = $1 LIMIT 1`, [orgId])
			: await db.query(`SELECT id FROM collections WHERE is_system = true AND user_id = $1 AND organization_id IS NULL LIMIT 1`, [body.userId]);
		return Response.json({ collectionId: retry.rows[0]?.id });
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
			};
			const variant = metadata.variant as string | undefined;
			if (variant === 'shared') {
				return buildTwitterShared(author, {
					media: (metadata.media as Array<{ url: string; type: 'photo' | 'video' | 'animated_gif' }>) || [],
					createdAt: metadata.createdAt as string | undefined,
					tweetText: metadata.tweetText as string | undefined,
					externalUrl: (metadata.externalUrl as string) || '',
					externalOgImage: metadata.externalOgImage as string | null | undefined,
					externalTitle: metadata.externalTitle as string | null | undefined,
				});
			}
			if (variant === 'article') {
				return buildTwitterArticle(author);
			}
			return buildTwitterStandard(author, {
				media: (metadata.media as Array<{ url: string; type: 'photo' | 'video' | 'animated_gif' }>) || [],
				createdAt: metadata.createdAt as string | undefined,
			});
		}
		default:
			return buildDefault();
	}
}

// ─────────────────────────────────────────────────────────────
// Generic bot account lookup (supports any platform)
// ─────────────────────────────────────────────────────────────

export async function handleBotLookup(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ found: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: { platform?: string; externalId?: string };
	try {
		body = (await request.json()) as { platform?: string; externalId?: string };
	} catch {
		return Response.json({ found: false, error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.platform || !body.externalId) {
		return Response.json({ found: false, error: 'Missing platform or externalId' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		const result = await db.query(`SELECT "userId" FROM account WHERE "providerId" = $1 AND "accountId" = $2`, [
			body.platform,
			body.externalId,
		]);
		const data = result.rows[0];
		if (!data) return Response.json({ found: false });
		return Response.json({ found: true, userId: data.userId });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Resolve feishu chat_id → organization
// ─────────────────────────────────────────────────────────────

export async function handleBotResolveOrg(request: Request, env: Env): Promise<Response> {
	if (!(await isBotAuthorized(request, env))) {
		return Response.json({ found: false, error: 'Unauthorized' }, { status: 401 });
	}

	let body: { feishuChatId?: string };
	try {
		body = (await request.json()) as { feishuChatId?: string };
	} catch {
		return Response.json({ found: false, error: 'Invalid JSON' }, { status: 400 });
	}

	if (!body.feishuChatId) {
		return Response.json({ found: false, error: 'Missing feishuChatId' }, { status: 400 });
	}

	const db = await createDbClient(env);
	try {
		const result = await db.query(
			`SELECT id, name FROM organization WHERE metadata->>'feishuChatId' = $1 LIMIT 1`,
			[body.feishuChatId],
		);
		const data = result.rows[0];
		if (!data) return Response.json({ found: false });
		return Response.json({ found: true, organizationId: data.id, orgName: data.name });
	} finally {
		await db.end();
	}
}