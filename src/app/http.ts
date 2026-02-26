import { detectPlatformType, type ScrapedContent, scrapeUrl } from '../domain/scrapers';
import { getArticlesTable, getSupabaseClient } from '../infra/db';
import { logError, logInfo, logWarn } from '../infra/log';
import { normalizeUrl } from '../infra/web';
import type { PlatformMetadata } from '../models/platform-metadata';
import { buildDefault, buildHackerNews, buildTwitterStandard, buildYouTube } from '../models/platform-metadata';
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

function hitSubmitRateLimit(key: string, max: number, windowSec: number, cost = 1): { limited: boolean; retryAfterSec: number } {
	const now = Date.now();
	const windowMs = Math.max(windowSec, 1) * 1000;
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
): Promise<{ articleId: string; scraped: ScrapedContent; platformType: string } | { error: string }> {
	const platformType = detectPlatformType(url);
	const scraped = await scrapeUrl(url, {
		youtubeApiKey: env.YOUTUBE_API_KEY,
		transcriptApiKey: env.TRANSCRIPT_API_KEY,
		kaitoApiKey: env.KAITO_API_KEY,
	});

	const skipContentCheck = platformType === 'youtube' || platformType === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return { error: 'Content too short' };
	}

	let cleanedMetadata = scraped.metadata;
	if (platformType === 'youtube' && scraped.metadata) {
		cleanedMetadata = await saveYouTubeTranscript(scraped.metadata, env);
	}

	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);
	const normalizedPlatformMetadata = normalizePlatformMetadata(cleanedMetadata, platformType);
	const { data: inserted, error } = await supabase
		.from(table)
		.insert([
			{
				url,
				title: scraped.title,
				source: scraped.siteName || 'External',
				published_date: scraped.publishedDate || new Date().toISOString(),
				scraped_date: new Date().toISOString(),
				summary: scraped.summary || '',
				source_type: platformType,
				content: scraped.content || null,
				og_image_url: scraped.ogImageUrl || null,
				keywords: [],
				tags: [],
				tokens: [],
				platform_metadata: normalizedPlatformMetadata,
			},
		])
		.select('id');

	if (error || !inserted?.[0]?.id) {
		logError('SUBMIT', 'DB insert failed', { url, error: String(error) });
		return { error: 'DB insert failed' };
	}

	logInfo('SUBMIT', 'Saved raw article', { title: scraped.title.slice(0, 50) });
	return { articleId: inserted[0].id, scraped, platformType };
}

/**
 * URL processing: scrape + DB insert + create Workflow (no waiting for AI)
 * Returns immediately with articleId + instanceId, AI processing happens in background via Workflow
 */
async function processUrl(rawUrl: string, env: Env): Promise<SubmitResult> {
	const url = normalizeUrl(rawUrl);
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);

	// 1. Check if already exists
	const { data: existing } = await supabase.from(table).select('id, title, title_cn, source_type, og_image_url').eq('url', url).single();
	if (existing) {
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

	// 2. Scrape + insert
	let result: Awaited<ReturnType<typeof scrapeAndInsert>>;
	try {
		result = await scrapeAndInsert(url, env);
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
	const results = await Promise.all(urls.map((url) => processUrl(url, env)));
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
				const supabase = getSupabaseClient(env);
				const table = getArticlesTable(env);
				const { data: article } = await supabase.from(table).select(ARTICLE_FIELDS).eq('id', articleId).single();
				return Response.json({ status: 'complete', article });
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
						const supabase = getSupabaseClient(env);
						const table = getArticlesTable(env);
						const { data: article } = await supabase.from(table).select(ARTICLE_FIELDS).eq('id', articleId).single();
						await writeEvent({ status: 'complete', article });
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

	const supabase = getSupabaseClient(env);
	const { data } = await supabase.from('account').select('userId').eq('providerId', 'telegram').eq('accountId', body.telegramId).single();

	if (!data) return Response.json({ found: false });
	return Response.json({ found: true, userId: data.userId });
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

	const supabase = getSupabaseClient(env);
	const { data, error } = await supabase
		.from('collections')
		.select('id, name, icon, is_default, is_system')
		.eq('user_id', body.userId)
		.order('is_system', { ascending: false })
		.order('is_default', { ascending: false })
		.order('updated_at', { ascending: false })
		.limit(10);

	if (error) {
		logError('TELEGRAM', 'Collections query error', { error: String(error) });
		return Response.json({ collections: [] });
	}

	const collections = (data ?? []).map((c) => ({
		id: c.id,
		name: c.name,
		icon: c.icon,
		isDefault: c.is_default,
		isSystem: c.is_system,
	}));

	return Response.json({ collections });
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

	const supabase = getSupabaseClient(env);

	// Ensure the target collection belongs to the requesting user.
	const { data: ownedCollection, error: collectionError } = await supabase
		.from('collections')
		.select('id')
		.eq('id', collectionId)
		.eq('user_id', userId)
		.maybeSingle();

	if (collectionError) {
		logError('TELEGRAM', 'Collection ownership check failed', { collectionId, userId, error: String(collectionError) });
		return Response.json({ success: false, error: 'Collection lookup failed' }, { status: 500 });
	}

	if (!ownedCollection) {
		return Response.json({ success: false, error: 'Invalid collection for user' }, { status: 403 });
	}

	// Verify article exists
	const table = getArticlesTable(env);
	const { data: articleExists } = await supabase.from(table).select('id').eq('id', articleId).maybeSingle();
	if (!articleExists) {
		return Response.json({ success: false, error: 'Article not found' }, { status: 404 });
	}

	// Check if already exists
	const { data: existing } = await supabase
		.from('citations')
		.select('id')
		.eq('from_type', 'collection')
		.eq('from_id', collectionId)
		.eq('to_type', 'article')
		.eq('to_id', articleId)
		.eq('user_id', userId)
		.single();

	if (existing) {
		return Response.json({ success: false, error: 'already_exists' });
	}

	// Insert citation
	const { error: insertError } = await supabase.from('citations').insert({
		from_type: 'collection',
		from_id: collectionId,
		to_type: 'article',
		to_id: articleId,
		relation_type: 'resource',
		user_id: userId,
	});

	if (insertError) {
		logError('TELEGRAM', 'Citation insert error', { error: String(insertError) });
		return Response.json({ success: false, error: 'Insert failed' }, { status: 500 });
	}

	// Increment article_count
	const { error: updateError } = await supabase.rpc('increment_collection_article_count', {
		collection_id: collectionId,
	});

	if (updateError) {
		// Fallback: manual increment
		const { data: col } = await supabase.from('collections').select('article_count').eq('id', collectionId).eq('user_id', userId).single();
		if (col) {
			await supabase
				.from('collections')
				.update({ article_count: (col.article_count ?? 0) + 1 })
				.eq('id', collectionId)
				.eq('user_id', userId);
		}
	}

	return Response.json({ success: true });
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
		case 'twitter':
			return buildTwitterStandard(
				{
					authorName: (metadata.authorName as string) || '',
					authorUserName: (metadata.authorUserName as string) || '',
					authorProfilePicture: metadata.authorProfilePicture as string | undefined,
					authorVerified: metadata.authorVerified as boolean | undefined,
				},
				{
					tweetId: metadata.tweetId as string | undefined,
					media: (metadata.media as Array<{ url: string; type: 'photo' | 'video' | 'animated_gif' }>) || [],
					createdAt: metadata.createdAt as string | undefined,
				},
			);
		default:
			return buildDefault();
	}
}

/**
 * Extract transcript data from YouTube metadata and save to youtube_transcripts table
 * Returns cleaned metadata without transcript fields only when transcript table write succeeds
 */
async function saveYouTubeTranscript(metadata: Record<string, unknown>, env: Env): Promise<Record<string, unknown>> {
	const videoId = metadata.videoId as string | undefined;
	if (!videoId) return metadata;

	const transcript = metadata.transcript;
	const chapters = metadata.chapters;
	const transcriptLanguage = metadata.transcriptLanguage as string | undefined;
	const chaptersFromDescription = metadata.chaptersFromDescription as boolean | undefined;

	// Only save if we have transcript data
	let persistedToTranscriptTable = false;
	if (transcript && Array.isArray(transcript) && transcript.length > 0) {
		const supabase = getSupabaseClient(env);

		try {
			const { error } = await supabase.from('youtube_transcripts').upsert(
				{
					video_id: videoId,
					transcript,
					language: transcriptLanguage || null,
					chapters: chapters || [],
					chapters_from_description: chaptersFromDescription || false,
					fetched_at: new Date().toISOString(),
				},
				{ onConflict: 'video_id' },
			);

			if (error) {
				logError('YOUTUBE', 'Failed to save transcript', { videoId, error: String(error) });
			} else {
				persistedToTranscriptTable = true;
				logInfo('YOUTUBE', 'Saved transcript', { videoId, segments: (transcript as unknown[]).length });
			}
		} catch (err) {
			logError('YOUTUBE', 'Failed to save transcript', { videoId, error: String(err) });
		}
	}

	// Keep transcript/chapter fields in platform_metadata when write failed or wasn't attempted.
	// This prevents permanent data loss for legacy/fallback reads.
	if (!persistedToTranscriptTable) {
		return metadata;
	}

	// Return metadata without transcript fields (keep it lightweight) after successful persistence
	const { transcript: _t, chapters: _c, transcriptLanguage: _l, chaptersFromDescription: _d, ...cleanMetadata } = metadata;
	return cleanMetadata;
}
