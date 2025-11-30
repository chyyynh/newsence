import { Article, AIAnalysisResult, OpenRouterResponse } from '../types';

export async function callGeminiForAnalysis(article: Article, openrouterApiKey: string): Promise<AIAnalysisResult> {
	console.log(`[AI] Analyzing article: ${article.title.substring(0, 80)}...`);

	const content = article.content || article.summary || article.title;

	// Add timeout for AI calls to prevent hanging
	const timeoutMs = 30000; // 30 second timeout
	const prompt = `作為一個專業的新聞分析師和翻譯師,請分析以下新聞文章並提供結構化的分析結果,包含英文和中文版本。
		文章資訊:
		標題: ${article.title}
		來源: ${article.source}
		摘要: ${article.summary || article.summary_cn || '無摘要'}
		內容: ${content.substring(0, 2000)}...

		請以JSON格式回答,包含以下欄位:
		{
		"tags": ["標籤1", "標籤2", "標籤3"],
		"keywords": ["關鍵字1", "關鍵字2", "關鍵字3", "關鍵字4", "關鍵字5"],
		"title_en": "英文標題翻譯",
		"title_cn": "繁體中文標題翻譯",
		"summary_en": "English summary in 1-2 sentences",
		"summary_cn": "用繁體中文寫1-2句話的新聞摘要",
		"category": "新聞分類"
		}

		翻譯要求:
		- title_en: 將標題翻譯成自然流暢的英文
		- title_cn: 將標題翻譯成自然流暢的繁體中文
		- summary_en: 用英文寫簡潔的摘要
		- summary_cn: 用繁體中文寫簡潔的摘要

		標籤規則:
		- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
		- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
		- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
		- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
		- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

		分類選項: AI, Tech, Finance, Research, Business, Other

		請只回傳JSON,不要其他文字。`;

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
				'X-Title': 'app.newsence.xyz',
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
			console.error('[AI] OpenRouter API Error:', response.status, response.statusText, errorBody);
			throw new Error(`OpenRouter API error: ${response.status} - ${errorBody}`);
		}

		const data: OpenRouterResponse = await response.json();
		const rawContent = data.choices?.[0]?.message?.content || '';

		if (!rawContent || !rawContent.trim()) {
			throw new Error('Empty response from AI');
		}

		console.log('[AI] Raw AI response:', rawContent);

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
			console.error('[AI] Failed to parse AI response:', parseError);
			console.error('[AI] Raw content:', rawContent);

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
			console.error('[AI] Request timed out after', timeoutMs, 'ms');
		} else {
			console.error('[AI] Request failed:', fetchError);
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
