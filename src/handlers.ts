import { Env, ExecutionContext } from './types';
import { processArticlesByIds } from './queue';
import { getSupabaseClient, getArticlesTable } from './utils/supabase';
import { normalizeUrl, scrapeArticleContent, extractOgImage, extractTitleFromHtml } from './utils/rss';
import { callGeminiForAnalysis } from './utils/ai';
import { prepareArticleTextForEmbedding, generateArticleEmbedding, saveArticleEmbedding } from './utils/embedding';
import { scrapeUrl, detectPlatformType } from './scrapers';

// ─────────────────────────────────────────────────────────────
// Health & Status
// ─────────────────────────────────────────────────────────────

export function handleHealth(_env: Env): Response {
	return Response.json({
		status: 'ok',
		worker: 'newsence-core-test',
		timestamp: new Date().toISOString(),
	});
}

export function handleStatus(_env: Env): Response {
	return Response.json({
		worker: 'newsence-core-test',
		version: '1.0.0',
		features: ['rss-monitor', 'twitter-monitor', 'article-process', 'workflow'],
		timestamp: new Date().toISOString(),
	});
}

// ─────────────────────────────────────────────────────────────
// Manual Trigger
// ─────────────────────────────────────────────────────────────

type TriggerBody = {
	article_ids?: string[];
	source?: string;
	triggered_by?: string;
};

export async function handleManualTrigger(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let body: TriggerBody = {};

	try {
		body = (await request.json()) as TriggerBody;
	} catch {
		// Ignore JSON parse error and treat as empty body
	}

	const articleIds = body.article_ids || [];
	console.log(`[TRIGGER] Manual trigger received for ${articleIds.length} articles from ${body.triggered_by || 'manual'}`);

	ctx.waitUntil(processArticlesByIds(env, articleIds));

	return Response.json({
		status: 'started',
		message: 'Article processing started',
		article_count: articleIds.length,
		processing_mode: articleIds.length > 0 ? 'specific_articles' : 'recent_unprocessed',
	});
}

// ─────────────────────────────────────────────────────────────
// Submit URL
// ─────────────────────────────────────────────────────────────

type SubmitBody = {
	url: string;
	source?: string;
};

export async function handleSubmitUrl(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	let body: SubmitBody;

	try {
		body = (await request.json()) as SubmitBody;
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!body.url) {
		return Response.json({ error: 'Missing url field' }, { status: 400 });
	}

	const url = normalizeUrl(body.url);
	const source = body.source || 'Manual Submit';
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);

	// Check if already exists
	const { data: existing } = await supabase.from(table).select('id, title').eq('url', url).single();
	if (existing) {
		return Response.json({
			status: 'exists',
			message: 'Article already exists',
			article_id: existing.id,
			title: existing.title,
		});
	}

	// Scrape content
	console.log(`[SUBMIT] Scraping: ${url}`);
	const [content, ogImage] = await Promise.all([scrapeArticleContent(url), extractOgImage(url)]);

	if (!content || content.length < 50) {
		return Response.json({ error: 'Failed to scrape content or content too short' }, { status: 422 });
	}

	const title = extractTitleFromHtml(content) || 'Submitted Article';

	// Insert to DB
	const articleData = {
		url,
		title,
		source,
		published_date: new Date(),
		scraped_date: new Date(),
		keywords: [],
		tags: [],
		tokens: [],
		summary: '',
		source_type: 'rss',
		content,
		og_image_url: ogImage,
		platform_metadata: {
			type: 'manual_submit',
			fetchedAt: new Date().toISOString(),
		},
	};

	const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');

	if (error) {
		console.error('[SUBMIT] Insert error:', error);
		return Response.json({ error: 'Failed to insert article' }, { status: 500 });
	}

	const articleId = inserted?.[0]?.id;

	// Send to queue for AI processing
	if (articleId) {
		await env.RSS_QUEUE.send({
			type: 'article_scraped',
			article_id: articleId,
			url,
			source,
			source_type: 'rss',
			timestamp: new Date().toISOString(),
		});
	}

	console.log(`[SUBMIT] Saved: ${title.slice(0, 50)}`);

	return Response.json({
		status: 'created',
		message: 'Article submitted successfully',
		article_id: articleId,
		title,
		url,
	});
}

// ─────────────────────────────────────────────────────────────
// Scrape URL (with AI translation)
// ─────────────────────────────────────────────────────────────

type ScrapeBody = {
	url: string;
	userId?: string;
};

export async function handleScrapeUrl(request: Request, env: Env): Promise<Response> {
	let body: ScrapeBody;

	try {
		body = (await request.json()) as ScrapeBody;
	} catch {
		return Response.json({ success: false, error: { code: 'INVALID_BODY', message: 'Invalid JSON body' } }, { status: 400 });
	}

	if (!body.url) {
		return Response.json({ success: false, error: { code: 'INVALID_URL', message: 'Missing URL' } }, { status: 400 });
	}

	const url = normalizeUrl(body.url);
	const platformType = detectPlatformType(url);
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);

	console.log(`[SCRAPE] Processing ${platformType} URL: ${url}`);

	// Check if already exists
	const { data: existing } = await supabase
		.from(table)
		.select('id, title, title_cn, summary_cn, og_image_url, source_type')
		.eq('url', url)
		.single();
	if (existing) {
		console.log(`[SCRAPE] Already exists: ${existing.id}`);
		return Response.json({
			success: true,
			alreadyExists: true,
			data: {
				articleId: existing.id,
				url,
				title: existing.title,
				titleCn: existing.title_cn,
				summaryCn: existing.summary_cn,
				ogImageUrl: existing.og_image_url,
				sourceType: existing.source_type || platformType,
			},
		});
	}

	// Use unified scraper for platform-specific content
	let scraped;
	try {
		scraped = await scrapeUrl(url, {
			youtubeApiKey: env.YOUTUBE_API_KEY,
			transcriptApiKey: env.TRANSCRIPT_API_KEY,
			kaitoApiKey: env.KAITO_API_KEY,
		});
	} catch (error) {
		console.error('[SCRAPE] Scraper error:', error);
		return Response.json(
			{ success: false, error: { code: 'SCRAPE_FAILED', message: String(error) } },
			{ status: 422 }
		);
	}

	if (!scraped.content || scraped.content.length < 50) {
		return Response.json(
			{ success: false, error: { code: 'SCRAPE_FAILED', message: 'Content too short' } },
			{ status: 422 }
		);
	}

	// AI Analysis (translate + summarize)
	console.log(`[SCRAPE] Running AI analysis for: ${scraped.title.slice(0, 50)}`);
	const aiResult = await callGeminiForAnalysis(
		{
			id: '',
			title: scraped.title,
			summary: scraped.summary ?? null,
			content: scraped.content,
			url,
			source: scraped.siteName || 'User Added',
			published_date: scraped.publishedDate || new Date().toISOString(),
			tags: [],
			keywords: [],
		},
		env.OPENROUTER_API_KEY
	);

	// Save to database
	const articleData = {
		url,
		title: scraped.title,
		title_cn: aiResult.title_cn || null,
		source: scraped.siteName || 'User Added',
		published_date: scraped.publishedDate || new Date().toISOString(),
		scraped_date: new Date().toISOString(),
		summary: aiResult.summary_en || scraped.summary || '',
		summary_cn: aiResult.summary_cn || null,
		source_type: platformType,
		content: scraped.content,
		og_image_url: scraped.ogImageUrl || null,
		keywords: aiResult.keywords || [],
		tags: aiResult.tags || [],
		tokens: [],
		platform_metadata: scraped.metadata
			? { type: platformType, fetchedAt: new Date().toISOString(), data: scraped.metadata }
			: null,
	};

	const { data: inserted, error } = await supabase.from(table).insert([articleData]).select('id');

	if (error) {
		console.error('[SCRAPE] Insert error:', error);
		return Response.json({ success: false, error: { code: 'DB_ERROR', message: 'Failed to save article' } }, { status: 500 });
	}

	const articleId = inserted?.[0]?.id;
	console.log(`[SCRAPE] Saved: ${aiResult.title_cn?.slice(0, 30) || scraped.title.slice(0, 30)}`);

	// Generate and save embedding
	if (articleId && env.AI) {
		const embeddingText = prepareArticleTextForEmbedding({
			title: scraped.title,
			title_cn: aiResult.title_cn,
			summary: aiResult.summary_en || scraped.summary,
			summary_cn: aiResult.summary_cn,
			tags: aiResult.tags,
			keywords: aiResult.keywords,
		});

		if (embeddingText) {
			const embedding = await generateArticleEmbedding(embeddingText, env.AI);
			if (embedding) {
				const saved = await saveArticleEmbedding(supabase, articleId, embedding, table);
				console.log(`[SCRAPE] Embedding ${saved ? 'saved' : 'failed'} (${embedding.length} dims)`);
			}
		}
	}

	return Response.json({
		success: true,
		data: {
			articleId,
			url,
			title: scraped.title,
			titleCn: aiResult.title_cn,
			summaryCn: aiResult.summary_cn,
			ogImageUrl: scraped.ogImageUrl,
			sourceType: platformType,
			tags: aiResult.tags,
			category: aiResult.category,
			author: scraped.author,
			metadata: scraped.metadata,
		},
	});
}

