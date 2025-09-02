import { createClient } from '@supabase/supabase-js';
import { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';

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
	published_date: string;
	tags: string[];
	keywords: string[];
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

interface OpenRouterResponse {
	choices: Array<{
		message: {
			content: string | null;
		};
	}>;
}

async function callGeminiForAnalysis(article: Article, openrouterApiKey: string): Promise<AIAnalysisResult> {
	console.log(`Analyzing article: ${article.title.substring(0, 80)}...`);

	const content = article.content || article.summary || article.title;

	// Add timeout for AI calls to prevent hanging
	const timeoutMs = 30000; // 30 second timeout
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

	// Create timeout controller
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
				'X-Title': 'newsence',
			},
			body: JSON.stringify({
				model: 'google/gemini-2.5-flash-lite',
				messages: [
					{
						role: 'user',
						content: [
							{
								type: 'text',
								text: prompt,
							},
						],
					},
				],
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

		try {
			// Try to extract JSON from the response
			const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				throw new Error('No JSON found in response');
			}

			const result: AIAnalysisResult = JSON.parse(jsonMatch[0]);

			// Validate the result
			if (!Array.isArray(result.tags) || !Array.isArray(result.keywords) || !result.summary_en || !result.summary_cn) {
				throw new Error('Invalid response format');
			}

			return {
				tags: result.tags.slice(0, 5), // Limit to 5 tags
				keywords: result.keywords.slice(0, 8), // Limit to 8 keywords
				summary_en: result.summary_en,
				summary_cn: result.summary_cn,
				title_en: result.title_en,
				title_cn: result.title_cn,
				category: result.category || 'Other',
			};
		} catch (parseError) {
			console.error('Failed to parse AI response:', parseError);
			console.error('Raw content:', rawContent);

			// Fallback: basic analysis
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
	} catch (fetchError: any) {
		clearTimeout(timeoutId);

		if (fetchError.name === 'AbortError') {
			console.error('AI request timed out after', timeoutMs, 'ms');
		} else {
			console.error('AI request failed:', fetchError);
		}

		// Fallback: basic analysis when network fails
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
}

async function processArticlesByIds(supabase: any, env: Env, articleIds?: string[]): Promise<void> {
	let articles;

	if (articleIds && articleIds.length > 0) {
		console.log(`Processing specific articles by IDs: ${articleIds.join(', ')}`);

		// Fetch specific articles by IDs
		const { data: specificArticles, error } = await supabase
			.from('articles')
			.select('id, title, title_cn, summary, summary_cn, content, url, source, published_date, tags, keywords, scraped_date')
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
			.select('id, title, title_cn, summary, summary_cn, content, url, source, published_date, tags, keywords, scraped_date')
			.gte('scraped_date', timeframe)
			.or('tags.is.null,keywords.is.null,title_cn.is.null,summary_cn.is.null,summary.is.null,title_cn.eq.,summary_cn.eq.,summary.eq.')
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

			const analysis = await callGeminiForAnalysis(article, env.OPENROUTER_API_KEY);

			// Update the article with AI analysis
			// Combine tags and category, removing duplicates
			const allTags = [...analysis.tags, analysis.category].filter((v, i, a) => a.indexOf(v) === i);

			// Prepare update object with only necessary fields
			const updateData: any = {};

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

			// Clear content after AI processing to save storage costs
			updateData.content = null;

			// Skip if nothing to update
			if (Object.keys(updateData).length === 1 && updateData.content === null) {
				console.log(`⏭️  Article ${article.id} already processed, skipping`);
				processedCount++; // Count as processed since it doesn't need work
				continue;
			}

			const { error: updateError } = await supabase.from('articles').update(updateData).eq('id', article.id);

			if (updateError) {
				console.error(`Error updating article ${article.id}:`, updateError);
				errorCount++;
			} else {
				console.log(`✅ Successfully processed article ${article.id}`);
				console.log(`   Updated fields: ${Object.keys(updateData).join(', ')}`);
				if (updateData.tags) console.log(`   Tags: ${updateData.tags.join(', ')}`);
				if (updateData.keywords) console.log(`   Keywords: ${updateData.keywords.join(', ')}`);
				if (updateData.title_cn) {
					console.log(`   Title EN: ${analysis.title_en}`);
					console.log(`   Title CN: ${analysis.title_cn}`);
					console.log(`   Summary EN: ${analysis.summary_en}`);
					console.log(`   Summary CN: ${analysis.summary_cn}`);
				}
				console.log(`   Category: ${analysis.category}`);
				processedCount++;
			}

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
			'OpenNews Article AI Analysis Worker\n\nPOST /process - Manually trigger processing\nOptional JSON body: { "article_ids": ["id1", "id2"], "source": "rss", "triggered_by": "workflow" }',
			{
				headers: { 'Content-Type': 'text/plain' },
			}
		);
	},
};
