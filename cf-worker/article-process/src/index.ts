import { createClient } from '@supabase/supabase-js';
import { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';
import * as cheerio from 'cheerio';

interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	OPENROUTER_API_KEY: string;
}

interface Article {
	id: string;
	title: string;
	title_cn?: string | null;
	summary: string | null;
	summary_cn?: string | null;
	content: string | null;
	url: string;
	source: string;
	source_type?: string | null;
	published_date: string;
	tags: string[];
	keywords: string[];
	og_image_url?: string | null;
}

interface AIAnalysisResult {
	tags: string[];
	keywords: string[];
	summary_en: string;
	summary_cn: string;
	title_en?: string;
	title_cn?: string;
	category: string;
}

// Phase 1: Article Segment for fine-grained search
interface ArticleSegment {
	article_id: string;
	seq: number;
	segment_text: string;
	metadata?: Record<string, any>;
}

/**
 * Split article content into segments for fine-grained search and citation
 * Segments are created based on paragraphs (double newlines)
 */
function segmentArticleContent(articleId: string, content: string): ArticleSegment[] {
	if (!content || content.trim().length === 0) {
		return [];
	}

	return content
		.split(/\n\n+/)
		.map((p) => p.trim())
		.filter((p) => p.length >= 50)
		.map((text, index) => ({
			article_id: articleId,
			seq: index,
			segment_text: text,
			metadata: {
				char_count: text.length,
				word_count: text.split(/\s+/).length,
			},
		}));
}

/**
 * Save article segments to database
 */
async function saveArticleSegments(supabase: any, articleId: string, segments: ArticleSegment[]): Promise<boolean> {
	if (segments.length === 0) {
		return true;
	}

	try {
		// First, delete existing segments for this article (in case of reprocessing)
		const { error: deleteError } = await supabase.from('article_segments').delete().eq('article_id', articleId);

		if (deleteError) {
			console.warn(`[Segments] Failed to delete existing segments for ${articleId}:`, deleteError.message);
			// Continue anyway - might be first time
		}

		// Insert new segments
		const { error: insertError } = await supabase.from('article_segments').insert(segments);

		if (insertError) {
			console.error(`[Segments] Failed to insert segments for ${articleId}:`, insertError.message);
			return false;
		}

		console.log(`[Segments] ✅ Created ${segments.length} segments for article ${articleId}`);
		return true;
	} catch (error: any) {
		console.error(`[Segments] Error saving segments for ${articleId}:`, error.message || error);
		return false;
	}
}

interface OpenRouterResponse {
	choices: Array<{
		message: {
			content: string | null;
		};
	}>;
}

interface EmbeddingResponse {
	data: Array<{ embedding: number[]; index: number }>;
}

const EMBEDDING_MODEL = 'google/gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 256;

/**
 * Prepare article text for embedding
 */
function prepareArticleTextForEmbedding(article: {
	title: string;
	title_cn?: string | null;
	summary?: string | null;
	summary_cn?: string | null;
}): string {
	return [article.title, article.title_cn, article.summary, article.summary_cn]
		.filter(Boolean)
		.join(' ')
		.slice(0, 8000);
}

/**
 * Normalize embedding vector
 */
function normalizeVector(values: number[]): number[] {
	const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
	if (norm === 0) return values;
	return values.map((v) => v / norm);
}

/**
 * Generate embedding for article using OpenRouter
 */
async function generateArticleEmbedding(text: string, openrouterApiKey: string): Promise<number[] | null> {
	if (!text || text.trim().length === 0) {
		return null;
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

		const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
			method: 'POST',
			signal: controller.signal,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${openrouterApiKey}`,
			},
			body: JSON.stringify({
				model: EMBEDDING_MODEL,
				input: text.trim().slice(0, 8000),
				dimensions: EMBEDDING_DIMENSIONS,
			}),
		});

		clearTimeout(timeout);

		if (!response.ok) {
			console.error(`[Embedding] API error: ${response.status}`);
			return null;
		}

		const data: EmbeddingResponse = await response.json();
		if (!data.data?.[0]?.embedding) {
			console.error('[Embedding] Invalid response format');
			return null;
		}

		return normalizeVector(data.data[0].embedding);
	} catch (error: any) {
		if (error.name === 'AbortError') {
			console.error('[Embedding] Request timed out');
		} else {
			console.error('[Embedding] Error:', error.message);
		}
		return null;
	}
}

/**
 * Save embedding to database
 */
async function saveArticleEmbedding(supabase: any, articleId: string, embedding: number[]): Promise<boolean> {
	try {
		const vectorStr = `[${embedding.join(',')}]`;

		const { error } = await supabase.rpc('update_article_embedding', {
			article_id: articleId,
			embedding_vector: vectorStr,
		});

		if (error) {
			// Fallback: direct SQL update if RPC doesn't exist
			const { error: directError } = await supabase
				.from('articles')
				.update({ embedding: vectorStr })
				.eq('id', articleId);

			if (directError) {
				console.error(`[Embedding] Failed to save embedding for ${articleId}:`, directError.message);
				return false;
			}
		}

		return true;
	} catch (error: any) {
		console.error(`[Embedding] Error saving embedding for ${articleId}:`, error.message);
		return false;
	}
}

async function extractOgImage(url: string): Promise<string | null> {
	try {
		console.log(`[OG Image] Extracting og:image from ${url}...`);
		const response = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; NewsenceBot/1.0)',
			},
		});

		if (!response.ok) {
			console.warn(`[OG Image] Failed to fetch ${url}: ${response.status}`);
			return null;
		}

		const html = await response.text();
		const $ = cheerio.load(html);

		// Try to get og:image from meta tags
		let imageUrl =
			$('meta[property="og:image"]').attr('content') ||
			$('meta[property="og:image:url"]').attr('content') ||
			$('meta[name="twitter:image"]').attr('content') ||
			$('meta[name="twitter:image:src"]').attr('content');

		// If image URL is relative, make it absolute
		if (imageUrl && !imageUrl.startsWith('http')) {
			try {
				const baseUrl = new URL(url);
				imageUrl = new URL(imageUrl, baseUrl.origin).toString();
			} catch (urlError) {
				console.warn(`[OG Image] Failed to convert relative URL to absolute: ${imageUrl}`);
				return null;
			}
		}

		if (imageUrl) {
			console.log(`[OG Image] Found og:image for ${url}: ${imageUrl}`);
		} else {
			console.log(`[OG Image] No og:image found for ${url}`);
		}

		return imageUrl || null;
	} catch (error: any) {
		console.warn(`[OG Image] Failed to extract og:image from ${url}:`, error.message || error);
		return null;
	}
}

/**
 * Twitter-specific: Translate tweet and generate tags/keywords
 * Simpler prompt since tweets are short
 */
async function translateTweet(tweetText: string, openrouterApiKey: string): Promise<{ summary_cn: string; tags: string[]; keywords: string[] }> {
	console.log(`Translating tweet: ${tweetText.substring(0, 60)}...`);

	const timeoutMs = 30000;
	const prompt = `請翻譯以下推文成繁體中文，並提供標籤和關鍵字。

推文內容：
${tweetText}

請以JSON格式回答：
{
  "summary_cn": "繁體中文翻譯",
  "tags": ["標籤1", "標籤2", "標籤3"],
  "keywords": ["關鍵字1", "關鍵字2", "關鍵字3"]
}

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, LLM, GenerativeAI
- 產品相關: Coding, Robotics, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Gaming, Creative
- 事件類型: ProductLaunch, Research, Partnership, Announcement

請只回傳JSON，不要其他文字。`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			signal: controller.signal,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${openrouterApiKey}`,
				'HTTP-Referer': 'https://app.newsence.xyz',
				'X-Title': 'app.newsence.xyz',
			},
			body: JSON.stringify({
				model: 'google/gemini-2.5-flash-lite',
				messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
				max_tokens: 500,
				temperature: 0.3,
			}),
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`OpenRouter API error: ${response.status}`);
		}

		const data: OpenRouterResponse = await response.json();
		const rawContent = data.choices?.[0]?.message?.content || '';

		const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			throw new Error('No JSON found in response');
		}

		const result = JSON.parse(jsonMatch[0]);

		return {
			summary_cn: result.summary_cn || tweetText,
			tags: (result.tags || ['Other']).slice(0, 5),
			keywords: (result.keywords || []).slice(0, 8),
		};
	} catch (error: any) {
		clearTimeout(timeoutId);
		console.error('Tweet translation failed:', error.message);

		// Fallback: return original text
		return {
			summary_cn: tweetText,
			tags: ['Twitter'],
			keywords: [],
		};
	}
}

function createFallbackAnalysis(article: Article): AIAnalysisResult {
	return {
		tags: ['Other'],
		keywords: article.title.split(' ').slice(0, 5),
		summary_en: article.summary || article.title.substring(0, 100) + '...',
		summary_cn: article.summary_cn || article.summary || article.title.substring(0, 100) + '...',
		title_en: article.title,
		title_cn: article.title_cn || article.title,
		category: 'Other',
	};
}

async function callGeminiForAnalysis(article: Article, openrouterApiKey: string): Promise<AIAnalysisResult> {
	console.log(`Analyzing article: ${article.title.substring(0, 80)}...`);

	const content = article.content || article.summary || article.title;
	const timeoutMs = 30000;
	const prompt = `作為一個專業的新聞分析師和翻譯師，請分析以下新聞文章並提供結構化的分析結果，包含英文和中文版本。
		文章資訊：
		標題: ${article.title}
		來源: ${article.source}
		摘要: ${article.summary || article.summary_cn || '無摘要'}
		內容: ${content.substring(0, 2000)}...

		請以JSON格式回答，包含以下欄位：
		{
		"tags": ["標籤1", "標籤2", "標籤3"],
		"keywords": ["關鍵字1", "關鍵字2", "關鍵字3", "關鍵字4", "關鍵字5"],
		"title_en": "英文標題翻譯",
		"title_cn": "繁體中文標題翻譯",
		"summary_en": "English summary in 1-2 sentences",
		"summary_cn": "用繁體中文寫1-2句話的新聞摘要",
		"category": "新聞分類"
		}

		翻譯要求：
		- title_en: 將標題翻譯成自然流暢的英文
		- title_cn: 將標題翻譯成自然流暢的繁體中文
		- summary_en: 用英文寫簡潔的摘要
		- summary_cn: 用繁體中文寫簡潔的摘要

		標籤規則：
		- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
		- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
		- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
		- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
		- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

		分類選項: AI, Tech, Finance, Research, Business, Other

		請只回傳JSON，不要其他文字。`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			signal: controller.signal,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${openrouterApiKey}`,
				'HTTP-Referer': 'https://app.newsence.xyz',
				'X-Title': 'app.newsence.xyz',
			},
			body: JSON.stringify({
				model: 'google/gemini-2.5-flash-lite',
				messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
				max_tokens: 800,
				temperature: 0.3,
			}),
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const errorBody = await response.text();
			console.error('OpenRouter API Error:', response.status, response.statusText, errorBody);
			throw new Error(`OpenRouter API error: ${response.status} - ${errorBody}`);
		}

		const data: OpenRouterResponse = await response.json();
		const rawContent = data.choices?.[0]?.message?.content || '';

		if (!rawContent || !rawContent.trim()) {
			throw new Error('Empty response from AI');
		}

		console.log('Raw AI response:', rawContent);

		const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			console.error('No JSON found in response, raw content:', rawContent);
			return createFallbackAnalysis(article);
		}

		const result: AIAnalysisResult = JSON.parse(jsonMatch[0]);

		if (!Array.isArray(result.tags) || !Array.isArray(result.keywords) || !result.summary_en || !result.summary_cn) {
			console.error('Invalid response format');
			return createFallbackAnalysis(article);
		}

		return {
			tags: result.tags.slice(0, 5),
			keywords: result.keywords.slice(0, 8),
			summary_en: result.summary_en,
			summary_cn: result.summary_cn,
			title_en: result.title_en,
			title_cn: result.title_cn,
			category: result.category || 'Other',
		};
	} catch (error: any) {
		clearTimeout(timeoutId);

		if (error.name === 'AbortError') {
			console.error('AI request timed out after', timeoutMs, 'ms');
		} else {
			console.error('AI request failed:', error);
		}

		return createFallbackAnalysis(article);
	}
}

async function processArticlesByIds(supabase: any, env: Env, articleIds?: string[]): Promise<void> {
	let articles;

	if (articleIds && articleIds.length > 0) {
		console.log(`Processing specific articles by IDs: ${articleIds.join(', ')}`);

		// Fetch specific articles by IDs
		const { data: specificArticles, error } = await supabase
			.from('articles')
			.select('id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url')
			.in('id', articleIds);

		if (error) {
			console.error('Error fetching specific articles:', error);
			return;
		}

		articles = specificArticles;
	} else {
		// Fallback: Process articles from 24 hours ago for daily backup
		const timeframe = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		console.log(`No specific article IDs provided, processing articles since: ${timeframe}`);

		// Fetch articles that need processing - filter in database, not JavaScript
		const { data: timeFrameArticles, error } = await supabase
			.from('articles')
			.select('id, title, title_cn, summary, summary_cn, content, url, source, source_type, published_date, tags, keywords, scraped_date, og_image_url')
			.gte('scraped_date', timeframe)
			.or('tags.is.null,keywords.is.null,title_cn.is.null,summary_cn.is.null,summary.is.null,title_cn.eq.,summary_cn.eq.,summary.eq.,og_image_url.is.null')
			.order('scraped_date', { ascending: false });

		if (error) {
			console.error('Error fetching articles needing processing:', error);
			return;
		}

		articles = timeFrameArticles;
	}

	if (!articles || articles.length === 0) {
		console.log('No articles need processing');
		return;
	}

	console.log(`Found ${articles.length} articles that need AI processing`);

	let processedCount = 0;
	let errorCount = 0;

	// Process articles sequentially to avoid rate limiting
	for (let i = 0; i < articles.length; i++) {
		const article = articles[i];
		try {
			console.log(`Processing article ${i + 1}/${articles.length} - ${article.id}: ${article.title.substring(0, 60)}...`);

			// Extract og:image if not already present
			let ogImageUrl = article.og_image_url;
			if (!ogImageUrl && article.url) {
				ogImageUrl = await extractOgImage(article.url);
			}

			// Prepare update object with only necessary fields
			const updateData: any = {};

			// Twitter-specific processing: simpler logic
			if (article.source_type === 'twitter') {
				console.log(`[Twitter] Processing tweet...`);
				const tweetText = article.content || '';

				// summary = original tweet text
				if (!article.summary || article.summary.trim() === '') {
					updateData.summary = tweetText;
				}

				// Translate and get tags/keywords
				const tweetAnalysis = await translateTweet(tweetText, env.OPENROUTER_API_KEY);

				if (!article.summary_cn || article.summary_cn.trim() === '') {
					updateData.summary_cn = tweetAnalysis.summary_cn;
				}
				if (!article.tags || article.tags.length === 0) {
					updateData.tags = tweetAnalysis.tags;
				}
				if (!article.keywords || article.keywords.length === 0) {
					updateData.keywords = tweetAnalysis.keywords;
				}

				// Update og_image_url if extracted
				if (ogImageUrl && !article.og_image_url) {
					updateData.og_image_url = ogImageUrl;
				}
			} else {
				// Regular article processing
				const analysis = await callGeminiForAnalysis(article, env.OPENROUTER_API_KEY);

				// Update the article with AI analysis
				// Combine tags and category, removing duplicates
				const allTags = [...analysis.tags, analysis.category].filter((v, i, a) => a.indexOf(v) === i);

				// Update tags and keywords if needed
				if (!article.tags || article.tags.length === 0) {
					updateData.tags = allTags;
				}
				if (!article.keywords || article.keywords.length === 0) {
					updateData.keywords = analysis.keywords;
				}

				// Update translation fields if needed (check for null, empty, or undefined)
				if (!article.title_cn || article.title_cn.trim() === '') {
					updateData.title_cn = analysis.title_cn;
				}
				if (!article.summary || article.summary.trim() === '') {
					updateData.summary = analysis.summary_en; // English summary
				}
				if (!article.summary_cn || article.summary_cn.trim() === '') {
					updateData.summary_cn = analysis.summary_cn; // Chinese summary
				}
				// Update English title if we don't have Chinese title (means original was non-English)
				if (analysis.title_en && !article.title_cn) {
					updateData.title = analysis.title_en;
				}

				// Update og_image_url if extracted
				if (ogImageUrl && !article.og_image_url) {
					updateData.og_image_url = ogImageUrl;
				}
			}

			// Phase 1: Create article segments for fine-grained search and citation
			// Do this BEFORE clearing content
			if (article.content && article.content.trim().length > 0) {
				const segments = segmentArticleContent(article.id, article.content);
				if (segments.length > 0) {
					const segmentsSaved = await saveArticleSegments(supabase, article.id, segments);
					if (!segmentsSaved) {
						console.warn(`[Segments] Failed to save segments for ${article.id}, continuing...`);
					}
				}
			}

			// Skip database update if nothing changed
			const hasUpdates = Object.keys(updateData).length > 0;
			if (hasUpdates) {
				const { error: updateError } = await supabase.from('articles').update(updateData).eq('id', article.id);

				if (updateError) {
					console.error(`Error updating article ${article.id}:`, updateError);
					errorCount++;
					continue;
				}

				console.log(`✅ Successfully processed article ${article.id}`);
				console.log(`   Updated fields: ${Object.keys(updateData).join(', ')}`);
				if (updateData.tags) console.log(`   Tags: ${updateData.tags.join(', ')}`);
				if (updateData.keywords) console.log(`   Keywords: ${updateData.keywords.join(', ')}`);
				if (updateData.summary_cn) console.log(`   Summary CN: ${updateData.summary_cn.substring(0, 60)}...`);
				if (updateData.og_image_url) console.log(`   OG Image: ${updateData.og_image_url}`);
				if (article.content) {
					const segmentCount = segmentArticleContent(article.id, article.content).length;
					if (segmentCount > 0) {
						console.log(`   Segments: ${segmentCount} created`);
					}
				}
			} else {
				console.log(`⏭️  Article ${article.id} already processed, checking embedding...`);
			}

			// Generate embedding for all articles (both updated and skipped)
			const embeddingText = prepareArticleTextForEmbedding({
				title: article.title,
				title_cn: updateData.title_cn || article.title_cn,
				summary: updateData.summary || article.summary,
				summary_cn: updateData.summary_cn || article.summary_cn,
			});
			if (embeddingText) {
				const embedding = await generateArticleEmbedding(embeddingText, env.OPENROUTER_API_KEY);
				if (embedding) {
					const saved = await saveArticleEmbedding(supabase, article.id, embedding);
					console.log(`   [Embedding] ${saved ? '✅' : '❌'} ${embedding.length} dims`);
				}
			}

			processedCount++;

			// Reduced delay to avoid rate limiting while staying under time limits
			await new Promise((resolve) => setTimeout(resolve, 200)); // 200ms delay (reduced from 500ms)
		} catch (error) {
			console.error(`Error processing article ${article.id}:`, error);
			errorCount++;
			// Continue with next article
		}
	}

	console.log(`\n📊 Processing Summary:`);
	console.log(`   Articles needing processing: ${articles.length}`);
	console.log(`   Successfully processed: ${processedCount}`);
	console.log(`   Errors: ${errorCount}`);
}

export default {
	// Handle queue messages from workflow orchestrator
	async queue(batch: any, env: Env, ctx: ExecutionContext): Promise<void> {
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

		console.log(`Processing ${batch.messages.length} article processing queue messages`);

		for (const message of batch.messages) {
			try {
				const messageData = message.body;

				// Check if message body exists
				if (!messageData) {
					console.warn('Received message with undefined body, skipping...');
					message.ack();
					continue;
				}

				if (messageData.type === 'process_articles') {
					const { article_ids, source, triggered_by, batch_info } = messageData;

					console.log(`Processing batch from ${triggered_by}, source: ${source}, articles: ${article_ids.length}`);
					if (batch_info) {
						console.log(`Batch info: ${batch_info.batch_size} articles, ${batch_info.total_batches} total batches`);
					}

					// Process the articles with waitUntil for proper queue management
					// Queue timeout is now 120s which is sufficient
					ctx.waitUntil(processArticlesByIds(supabase, env, article_ids));

					// Acknowledge the message
					message.ack();
					console.log(`✅ Acknowledged processing of ${article_ids.length} articles`);
				} else {
					console.warn('Unknown message type:', messageData.type);
					message.ack(); // Acknowledge unknown message types
				}
			} catch (error) {
				console.error('Error processing queue message:', error);
				message.retry(); // Retry on error
			}
		}
	},

	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('🤖 Daily Backup Article Processing started');

		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

		try {
			// Run without article IDs to process all unprocessed articles as backup
			await processArticlesByIds(supabase, env);
			console.log('✅ Daily Backup Article Processing completed successfully');
		} catch (error) {
			console.error('❌ Daily Backup Article Processing failed:', error);
			throw error; // Re-throw to ensure Cloudflare logs the failure
		}
	},

	// HTTP endpoint for manual triggering and workflow integration
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/process' && request.method === 'POST') {
			const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

			try {
				const body = (await request.json().catch(() => ({}))) as {
					article_ids?: string[];
					source?: string;
					triggered_by?: string;
				};
				const articleIds = body.article_ids;
				const source = body.source;
				const triggeredBy = body.triggered_by;

				console.log(`Processing request from ${triggeredBy || 'manual'} for source: ${source || 'unknown'}`);
				if (articleIds && articleIds.length > 0) {
					console.log(`Processing ${articleIds.length} specific articles: ${articleIds.join(', ')}`);
				}

				// Use waitUntil for HTTP requests to allow async processing
				ctx.waitUntil(processArticlesByIds(supabase, env, articleIds));

				return new Response(
					JSON.stringify({
						status: 'started',
						message: 'Article processing started',
						article_count: articleIds?.length ?? 0,
						processing_mode: (articleIds?.length ?? 0) > 0 ? 'specific_articles' : 'recent_unprocessed',
					}),
					{
						headers: { 'Content-Type': 'application/json' },
					}
				);
			} catch (error) {
				console.error('Error processing request:', error);
				return new Response(
					JSON.stringify({
						status: 'error',
						message: 'Failed to process request',
					}),
					{
						status: 500,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}
		}

		return new Response(
			'Newsence Article AI Analysis Worker\n\nPOST /process - Manually trigger processing\nOptional JSON body: { "article_ids": ["id1", "id2"], "source": "rss", "triggered_by": "workflow" }',
			{
				headers: { 'Content-Type': 'text/plain' },
			}
		);
	},
};
