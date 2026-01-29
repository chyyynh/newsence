import { Env, ExecutionContext } from './types';
import { getSupabaseClient, getArticlesTable } from './utils/supabase';
import { normalizeUrl, scrapeArticleContent, extractOgImage } from './utils/rss';
import { getProcessor, ProcessorContext } from './processors';
import { prepareArticleTextForEmbedding, generateArticleEmbedding, saveArticleEmbedding } from './utils/embedding';
import { scrapeUrl, detectPlatformType, scrapeYouTube } from './scrapers';

// ─────────────────────────────────────────────────────────────
// Health & Status
// ─────────────────────────────────────────────────────────────

export function handleHealth(_env: Env): Response {
	return Response.json({
		status: 'ok',
		worker: 'newsence-core',
		timestamp: new Date().toISOString(),
	});
}

export function handleStatus(_env: Env): Response {
	return Response.json({
		worker: 'newsence-core',
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

export async function handleManualTrigger(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
	let body: TriggerBody = {};

	try {
		body = (await request.json()) as TriggerBody;
	} catch {
		// Ignore JSON parse error and treat as empty body
	}

	const articleIds = body.article_ids || [];
	const triggeredBy = body.triggered_by || 'manual';
	console.log(`[TRIGGER] Manual trigger received for ${articleIds.length} articles from ${triggeredBy}`);

	if (articleIds.length > 0) {
		await env.ARTICLE_QUEUE.send({
			type: 'batch_process',
			article_ids: articleIds,
			triggered_by: triggeredBy,
		});
	}

	return Response.json({
		status: 'started',
		message: 'Article processing queued',
		article_count: articleIds.length,
		processing_mode: articleIds.length > 0 ? 'specific_articles' : 'none',
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

	const titleMatch = content.match(/^#\s+(.+)$/m);
	const title = titleMatch?.[1]?.trim() || 'Submitted Article';

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
		await env.ARTICLE_QUEUE.send({
			type: 'article_process',
			article_id: articleId,
			source_type: 'rss',
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
	skipSave?: boolean; // If true, only scrape without AI analysis or DB save (preview mode)
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
	const skipSave = body.skipSave === true;

	console.log(`[SCRAPE] Processing ${platformType} URL: ${url}${skipSave ? ' (preview mode)' : ''}`);

	// Check if already exists (skip for preview mode)
	if (!skipSave) {
		const supabase = getSupabaseClient(env);
		const table = getArticlesTable(env);

		const { data: existing } = await supabase
			.from(table)
			.select('id, title, title_cn, content, summary, summary_cn, source, source_type, og_image_url, published_date, author')
			.eq('url', url)
			.single();
		if (existing) {
			console.log(`[SCRAPE] Already exists: ${existing.id}`);
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
					author: existing.author,
				},
			});
		}
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

	// Preview mode: return scraped data without AI analysis or DB save
	if (skipSave) {
		console.log(`[SCRAPE] Preview complete: ${scraped.title.slice(0, 50)}`);
		return Response.json({
			success: true,
			preview: true,
			data: {
				url,
				normalizedUrl: url,
				title: scraped.title,
				content: scraped.content,
				summary: scraped.summary,
				source: scraped.siteName || 'Unknown',
				sourceType: platformType,
				ogImageUrl: scraped.ogImageUrl,
				publishedDate: scraped.publishedDate,
				author: scraped.author,
				metadata: scraped.metadata,
			},
		});
	}

	// Full mode: Insert raw article → Processor AI → Update DB → Embedding
	const supabase = getSupabaseClient(env);
	const table = getArticlesTable(env);

	// Insert raw article first
	const rawArticleData = {
		url,
		title: scraped.title,
		source: scraped.siteName || 'User Added',
		published_date: scraped.publishedDate || new Date().toISOString(),
		scraped_date: new Date().toISOString(),
		summary: scraped.summary || '',
		source_type: platformType,
		content: scraped.content,
		og_image_url: scraped.ogImageUrl || null,
		keywords: [],
		tags: [],
		tokens: [],
		platform_metadata: scraped.metadata
			? { type: scraped.metadata.type || platformType, fetchedAt: new Date().toISOString(), data: scraped.metadata }
			: null,
	};

	const { data: inserted, error } = await supabase.from(table).insert([rawArticleData]).select('id');

	if (error) {
		console.error('[SCRAPE] Insert error:', error);
		return Response.json({ success: false, error: { code: 'DB_ERROR', message: 'Failed to save article' } }, { status: 500 });
	}

	const articleId = inserted?.[0]?.id;
	console.log(`[SCRAPE] Saved raw article: ${scraped.title.slice(0, 50)}`);

	// Run processor (same path as Workflow Step 2)
	const article = {
		id: articleId || '',
		title: scraped.title,
		summary: scraped.summary ?? null,
		content: scraped.content,
		url,
		source: scraped.siteName || 'User Added',
		published_date: scraped.publishedDate || new Date().toISOString(),
		tags: [] as string[],
		keywords: [] as string[],
		source_type: platformType,
		platform_metadata: rawArticleData.platform_metadata ?? undefined,
	};

	console.log(`[SCRAPE] Running ${platformType} processor for: ${scraped.title.slice(0, 50)}`);
	const processor = getProcessor(platformType);
	const ctx: ProcessorContext = { env, supabase, table };
	const result = await processor.process(article, ctx);

	// Update DB with processor results (same as Workflow Step 3)
	if (Object.keys(result.updateData).length > 0) {
		await supabase.from(table).update(result.updateData).eq('id', articleId);
	}
	if (result.enrichments && Object.keys(result.enrichments).length > 0) {
		const updatedMetadata = {
			...(rawArticleData.platform_metadata || {}),
			enrichments: { ...result.enrichments, processedAt: new Date().toISOString() },
		};
		await supabase.from(table).update({ platform_metadata: updatedMetadata }).eq('id', articleId);
	}

	const titleCn = result.updateData.title_cn ?? null;
	const summary = result.updateData.summary ?? scraped.summary ?? '';
	const summaryCn = result.updateData.summary_cn ?? null;
	const tags = result.updateData.tags ?? [];
	const keywords = result.updateData.keywords ?? [];

	console.log(`[SCRAPE] Processed: ${titleCn?.slice(0, 30) || scraped.title.slice(0, 30)}`);

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
				console.log(`[SCRAPE] Embedding ${saved ? 'saved' : 'failed'} (${embedding.length} dims)`);
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
			content: scraped.content,
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

// ─────────────────────────────────────────────────────────────
// YouTube Metadata (lightweight, no DB save)
// ─────────────────────────────────────────────────────────────

export async function handleYouTubeMetadata(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const videoId = url.searchParams.get('videoId');

	if (!videoId) {
		return Response.json({ success: false, error: { code: 'INVALID_URL', message: 'videoId is required' } }, { status: 400 });
	}

	if (!env.YOUTUBE_API_KEY) {
		return Response.json({ success: false, error: { code: 'CONFIG_ERROR', message: 'YouTube API key not configured' } }, { status: 500 });
	}

	try {
		const result = await scrapeYouTube(videoId, env.YOUTUBE_API_KEY, env.TRANSCRIPT_API_KEY);
		return Response.json({
			success: true,
			data: result.metadata || {},
		});
	} catch (error) {
		console.error('[YOUTUBE] Metadata error:', error);
		return Response.json(
			{ success: false, error: { code: 'FETCH_FAILED', message: String(error) } },
			{ status: 500 }
		);
	}
}

