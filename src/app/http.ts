import { Article, Env } from '../models/types';
import { getSupabaseClient, getArticlesTable } from '../infra/db';
import { normalizeUrl } from '../infra/web';
import { prepareArticleTextForEmbedding, generateArticleEmbedding, saveArticleEmbedding } from '../infra/embedding';
import { scrapeUrl, detectPlatformType } from '../domain/scrapers';
import { runArticleProcessor, persistProcessorResult } from '../domain/processors';

const DEFAULT_SUBMIT_RATE_LIMIT_MAX = 20;
const DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC = 60;

type RateBucket = { count: number; resetAt: number };
const submitRateBuckets = new Map<string, RateBucket>();

function getInternalToken(request: Request): string | null {
	return request.headers.get('x-internal-token') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

function isSubmitAuthorized(request: Request, env: Env): boolean {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) return true; // Backward-compatible when token is not configured yet
	const provided = getInternalToken(request)?.trim();
	return Boolean(provided && provided === expected);
}

function getSubmitRateKey(request: Request, userId?: string): string {
	const normalizedUserId = userId?.trim();
	if (normalizedUserId) return `user:${normalizedUserId}`;
	const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	return ip ? `ip:${ip}` : 'anon';
}

function hitSubmitRateLimit(key: string, max: number, windowSec: number): { limited: boolean; retryAfterSec: number } {
	const now = Date.now();
	const windowMs = Math.max(windowSec, 1) * 1000;
	const existing = submitRateBuckets.get(key);

	if (!existing || existing.resetAt <= now) {
		submitRateBuckets.set(key, { count: 1, resetAt: now + windowMs });
		return { limited: false, retryAfterSec: 0 };
	}

	if (existing.count >= max) {
		return { limited: true, retryAfterSec: Math.max(Math.ceil((existing.resetAt - now) / 1000), 1) };
	}

	existing.count += 1;
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
	url?: string;         // Legacy single URL (backward compatible)
	urls?: string[];      // Batch URLs
	userId?: string;
	mode?: 'fast' | 'full';  // fast = Queue background, full = sync AI (default)
};

type SubmitResultFast = {
	url: string;
	articleId?: string;
	alreadyExists?: boolean;
	error?: string;
};

type SubmitResultFull = {
	articleId: string;
	url: string;
	title: string;
	titleCn?: string | null;
	content?: string | null;
	summary?: string;
	summaryCn?: string | null;
	source: string;
	sourceType: string;
	ogImageUrl?: string | null;
	publishedDate?: string;
	tags?: string[];
	keywords?: string[];
};

/**
 * Fast URL processing: scrape + DB insert + Queue (no waiting for AI)
 * Returns immediately with articleId, AI processing happens in background via Queue
 */
async function processUrlFast(rawUrl: string, env: Env): Promise<SubmitResultFast> {
	const url = normalizeUrl(rawUrl);
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);

	// 1. Check if already exists
	const { data: existing } = await supabase
		.from(table)
		.select('id, title_cn, source_type')
		.eq('url', url)
		.single();
	if (existing) {
		// Re-queue if article exists but hasn't been processed (missing title_cn indicates unprocessed)
		if (!existing.title_cn) {
			console.log(`[SUBMIT/fast] Re-queuing unprocessed article: ${existing.id}`);
			try {
				await env.ARTICLE_QUEUE.send({
					type: 'article_process',
					article_id: existing.id,
					source_type: existing.source_type || 'article',
				});
			} catch (queueErr) {
				console.error(`[SUBMIT/fast] Re-queue failed for ${existing.id}:`, queueErr);
			}
		}
		return { url, articleId: existing.id, alreadyExists: true };
	}

	// 2. Quick scrape
	const platformType = detectPlatformType(url);
	let scraped;
	try {
		scraped = await scrapeUrl(url, {
			youtubeApiKey: env.YOUTUBE_API_KEY,
			transcriptApiKey: env.TRANSCRIPT_API_KEY,
			kaitoApiKey: env.KAITO_API_KEY,
		});
	} catch (err) {
		console.error(`[SUBMIT/fast] Scrape failed for ${url}:`, err);
		return { url, error: `Scrape failed: ${err}` };
	}

	const skipContentCheck = platformType === 'youtube' || platformType === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return { url, error: 'Content too short' };
	}

	// 3. Insert raw article
	const normalizedPlatformMetadata = normalizePlatformMetadata(scraped.metadata, platformType);
	const rawArticleData = {
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
	};

	const { data: inserted, error } = await supabase.from(table).insert([rawArticleData]).select('id');
	if (error || !inserted?.[0]?.id) {
		console.error(`[SUBMIT/fast] DB insert failed for ${url}:`, error);
		return { url, error: 'DB insert failed' };
	}

	const articleId = inserted[0].id;
	console.log(`[SUBMIT/fast] Saved raw article: ${scraped.title.slice(0, 50)}`);

	// 4. Queue for background AI processing (best-effort, retry will re-queue if needed)
	try {
		await env.ARTICLE_QUEUE.send({
			type: 'article_process',
			article_id: articleId,
			source_type: platformType,
		});
	} catch (queueErr) {
		console.error(`[SUBMIT/fast] Queue send failed for ${articleId}:`, queueErr);
		// Article is saved; retry will detect it as existing and re-queue
	}

	return { url, articleId, alreadyExists: false };
}

/**
 * Full URL processing: scrape + AI analysis + embedding (synchronous)
 * Returns complete processed article data
 */
async function processUrlFull(
	rawUrl: string,
	env: Env
): Promise<{ success: true; alreadyExists: boolean; data: SubmitResultFull } | { success: false; error: string }> {
	const url = normalizeUrl(rawUrl);
	const platformType = detectPlatformType(url);
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);

	console.log(`[SUBMIT/full] Processing ${platformType} URL: ${url}`);

	// Check if already exists
	const { data: existing } = await supabase
		.from(table)
		.select('id, title, title_cn, content, summary, summary_cn, source, source_type, og_image_url, published_date')
		.eq('url', url)
		.single();

	if (existing) {
		console.log(`[SUBMIT/full] Already exists: ${existing.id}`);
		return {
			success: true,
			alreadyExists: true,
			data: {
				articleId: existing.id,
				url,
				title: existing.title,
				titleCn: existing.title_cn,
				content: existing.content || '',
				summary: existing.summary,
				summaryCn: existing.summary_cn,
				source: existing.source || '',
				sourceType: existing.source_type || platformType,
				ogImageUrl: existing.og_image_url,
				publishedDate: existing.published_date,
			},
		};
	}

	// Scrape
	let scraped;
	try {
		scraped = await scrapeUrl(url, {
			youtubeApiKey: env.YOUTUBE_API_KEY,
			transcriptApiKey: env.TRANSCRIPT_API_KEY,
			kaitoApiKey: env.KAITO_API_KEY,
		});
	} catch (error) {
		console.error('[SUBMIT/full] Crawl error:', error);
		return { success: false, error: `Crawl failed: ${error}` };
	}

	const skipContentCheck = platformType === 'youtube' || platformType === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return { success: false, error: 'Content too short' };
	}

	// Insert raw article
	const normalizedPlatformMetadata = normalizePlatformMetadata(scraped.metadata, platformType);
	const rawArticleData = {
		url,
		title: scraped.title,
		source: scraped.siteName || 'User Added',
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
	};

	const { data: inserted, error } = await supabase.from(table).insert([rawArticleData]).select('id');
	if (error) {
		console.error('[SUBMIT/full] Insert error:', error);
		return { success: false, error: 'Failed to save article' };
	}

	const articleId = inserted?.[0]?.id;
	console.log(`[SUBMIT/full] Saved raw article: ${scraped.title.slice(0, 50)}`);

	// Run AI processor
	const article = {
		id: articleId || '',
		title: scraped.title,
		summary: scraped.summary ?? null,
		content: scraped.content || null,
		url,
		source: scraped.siteName || 'User Added',
		published_date: scraped.publishedDate || new Date().toISOString(),
		tags: [] as string[],
		keywords: [] as string[],
		source_type: platformType,
		platform_metadata: normalizedPlatformMetadata ?? undefined,
	};

	console.log(`[SUBMIT/full] Running ${platformType} processor`);
	const result = await runArticleProcessor(article, platformType, { env, supabase, table });
	await persistProcessorResult(articleId, article, result, { env, supabase, table });

	const titleCn = result.updateData.title_cn ?? null;
	const summary = result.updateData.summary ?? scraped.summary ?? '';
	const summaryCn = result.updateData.summary_cn ?? null;
	const content = result.updateData.content ?? scraped.content;
	const tags = result.updateData.tags ?? [];
	const keywords = result.updateData.keywords ?? [];

	// Generate embedding
	if (articleId && env.AI) {
		const embeddingText = prepareArticleTextForEmbedding({
			title: scraped.title,
			title_cn: titleCn,
			summary,
			summary_cn: summaryCn,
			tags,
			keywords,
		});

		if (embeddingText) {
			const embedding = await generateArticleEmbedding(embeddingText, env.AI);
			if (embedding) {
				const saved = await saveArticleEmbedding(supabase, articleId, embedding, table);
				console.log(`[SUBMIT/full] Embedding ${saved ? 'saved' : 'failed'}`);
			}
		}
	}

	return {
		success: true,
		alreadyExists: false,
		data: {
			articleId,
			url,
			title: scraped.title,
			titleCn,
			content,
			summary,
			summaryCn,
			source: scraped.siteName || 'User Added',
			sourceType: platformType,
			ogImageUrl: scraped.ogImageUrl,
			publishedDate: scraped.publishedDate ?? undefined,
			tags,
			keywords,
		},
	};
}

export async function handleSubmitUrl(request: Request, env: Env): Promise<Response> {
	if (!isSubmitAuthorized(request, env)) {
		return Response.json(
			{ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' } },
			{ status: 401 }
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

	const max = Number.parseInt(env.SUBMIT_RATE_LIMIT_MAX || '', 10) || DEFAULT_SUBMIT_RATE_LIMIT_MAX;
	const windowSec =
		Number.parseInt(env.SUBMIT_RATE_LIMIT_WINDOW_SEC || '', 10) || DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC;
	const rateKey = getSubmitRateKey(request, body.userId);
	const rateResult = hitSubmitRateLimit(rateKey, Math.max(max, 1), Math.max(windowSec, 1));
	if (rateResult.limited) {
		return Response.json(
			{
				success: false,
				error: { code: 'RATE_LIMITED', message: `Too many submit requests. Retry in ${rateResult.retryAfterSec}s` },
			},
			{ status: 429, headers: { 'Retry-After': String(rateResult.retryAfterSec) } }
		);
	}

	const mode = body.mode ?? 'full';
	const urlsToProcess = urls.slice(0, 20);

	// Fast mode: Queue-based background processing, returns immediately
	if (mode === 'fast') {
		console.log(`[SUBMIT/fast] Processing ${urlsToProcess.length} URLs`);
		const results = await Promise.all(urlsToProcess.map((url) => processUrlFast(url, env)));
		return Response.json({ success: true, results });
	}

	// Full mode: Synchronous AI processing (legacy behavior, single URL only)
	if (urlsToProcess.length > 1) {
		return Response.json(
			{
				success: false,
				error: { code: 'INVALID_REQUEST', message: 'Full mode supports exactly one URL. Use mode "fast" for batches.' },
			},
			{ status: 400 }
		);
	}

	const url = urlsToProcess[0];
	const result = await processUrlFull(url, env);

	if (!result.success) {
		return Response.json(
			{ success: false, error: { code: 'PROCESS_FAILED', message: result.error } },
			{ status: 422 }
		);
	}

	return Response.json({
		success: true,
		alreadyExists: result.alreadyExists,
		existingArticleId: result.alreadyExists ? result.data.articleId : undefined,
		data: result.data,
	});
}

// ─────────────────────────────────────────────────────────────
// Telegram account lookup
// ─────────────────────────────────────────────────────────────

export async function handleTelegramLookup(request: Request, env: Env): Promise<Response> {
	if (!isSubmitAuthorized(request, env)) {
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
	const { data } = await supabase
		.from('account')
		.select('userId')
		.eq('providerId', 'telegram')
		.eq('accountId', body.telegramId)
		.single();

	if (!data) return Response.json({ found: false });
	return Response.json({ found: true, userId: data.userId });
}

// ─────────────────────────────────────────────────────────────
// Telegram: fetch user collections
// ─────────────────────────────────────────────────────────────

export async function handleTelegramCollections(request: Request, env: Env): Promise<Response> {
	if (!isSubmitAuthorized(request, env)) {
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
		console.error('[TELEGRAM] Collections query error:', error);
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
	if (!isSubmitAuthorized(request, env)) {
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
		console.error('[TELEGRAM] Citation insert error:', insertError);
		return Response.json({ success: false, error: 'Insert failed' }, { status: 500 });
	}

	// Increment article_count
	const { error: updateError } = await supabase.rpc('increment_collection_article_count', {
		collection_id: collectionId,
	});

	if (updateError) {
		// Fallback: manual increment
		const { data: col } = await supabase
			.from('collections')
			.select('article_count')
			.eq('id', collectionId)
			.single();
		if (col) {
			await supabase
				.from('collections')
				.update({ article_count: (col.article_count ?? 0) + 1 })
				.eq('id', collectionId);
		}
	}

	return Response.json({ success: true });
}

function normalizePlatformMetadata(
	metadata: Record<string, unknown> | undefined,
	fallbackType: string
): Article['platform_metadata'] | null {
	if (!metadata) return null;
	const rawType = metadata.type;
	const type = typeof rawType === 'string' && rawType.trim().length > 0 ? rawType : fallbackType;
	return {
		type,
		fetchedAt: new Date().toISOString(),
		data: metadata,
	};
}
