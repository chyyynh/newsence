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
// Submit URL (full processing)
// ─────────────────────────────────────────────────────────────

type SubmitBody = {
	url: string;
	userId?: string;
};

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

	if (!body.url) {
		return Response.json({ error: 'Missing url field' }, { status: 400 });
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

	const url = normalizeUrl(body.url);
	const platformType = detectPlatformType(url);

	console.log(`[SUBMIT] Processing ${platformType} URL: ${url}`);

	// Check if already exists
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);

	const { data: existing } = await supabase
		.from(table)
		.select('id, title, title_cn, content, summary, summary_cn, source, source_type, og_image_url, published_date')
		.eq('url', url)
		.single();
	if (existing) {
		console.log(`[SUBMIT] Already exists: ${existing.id}`);
		return Response.json({
			success: true,
			alreadyExists: true,
			existingArticleId: existing.id,
			data: {
				articleId: existing.id,
				url,
				normalizedUrl: url,
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
		});
	}

	// Use unified crawler for platform-specific content
	let scraped;
	try {
		scraped = await scrapeUrl(url, {
			youtubeApiKey: env.YOUTUBE_API_KEY,
			transcriptApiKey: env.TRANSCRIPT_API_KEY,
			kaitoApiKey: env.KAITO_API_KEY,
		});
	} catch (error) {
		console.error('[SUBMIT] Crawl error:', error);
		return Response.json(
			{ success: false, error: { code: 'CRAWL_FAILED', message: String(error) } },
			{ status: 422 }
		);
	}

	const skipContentCheck = platformType === 'youtube' || platformType === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return Response.json(
			{ success: false, error: { code: 'CRAWL_FAILED', message: 'Content too short' } },
			{ status: 422 }
		);
	}

	// Insert raw article -> Processor AI -> Update DB -> Embedding
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
		console.error('[SUBMIT] Insert error:', error);
		return Response.json({ success: false, error: { code: 'DB_ERROR', message: 'Failed to save article' } }, { status: 500 });
	}

	const articleId = inserted?.[0]?.id;
	console.log(`[SUBMIT] Saved raw article: ${scraped.title.slice(0, 50)}`);

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

	console.log(`[SUBMIT] Running ${platformType} processor for: ${scraped.title.slice(0, 50)}`);
	const result = await runArticleProcessor(article, platformType, { env, supabase, table });
	await persistProcessorResult(articleId, article, result, { env, supabase, table });

	const titleCn = result.updateData.title_cn ?? null;
	const summary = result.updateData.summary ?? scraped.summary ?? '';
	const summaryCn = result.updateData.summary_cn ?? null;
	const content = result.updateData.content ?? scraped.content;
	const tags = result.updateData.tags ?? [];
	const keywords = result.updateData.keywords ?? [];

	console.log(`[SUBMIT] Processed: ${titleCn?.slice(0, 30) || scraped.title.slice(0, 30)}`);

	// Generate and save embedding (same as Workflow Step 4+5)
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
				console.log(`[SUBMIT] Embedding ${saved ? 'saved' : 'failed'} (${embedding.length} dims)`);
			}
		}
	}

	return Response.json({
		success: true,
		data: {
			articleId,
			url,
			normalizedUrl: url,
			title: scraped.title,
			titleCn,
			content,
			summary,
			summaryCn,
			source: scraped.siteName || 'User Added',
			sourceType: platformType,
			ogImageUrl: scraped.ogImageUrl,
			publishedDate: scraped.publishedDate,
			author: scraped.author,
			tags,
			keywords,
			metadata: scraped.metadata,
		},
	});
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
