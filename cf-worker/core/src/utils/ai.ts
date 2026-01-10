import { Article, AIAnalysisResult, OpenRouterResponse } from '../types';

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const AI_MODEL = 'google/gemini-2.5-flash-lite';
const TIMEOUT_MS = 30000;
const MAX_CONTENT_LENGTH = 2000;

const OPENROUTER_HEADERS = {
	'Content-Type': 'application/json',
	'HTTP-Referer': 'https://app.newsence.xyz',
	'X-Title': 'app.newsence.xyz',
};

function createFallbackResult(article: Article): AIAnalysisResult {
	return {
		tags: ['Other'],
		keywords: article.title.split(' ').slice(0, 5),
		summary_en: article.summary ?? `${article.title.substring(0, 100)}...`,
		summary_cn: article.summary_cn ?? article.summary ?? `${article.title.substring(0, 100)}...`,
		title_en: article.title,
		title_cn: article.title_cn ?? article.title,
		category: 'Other',
	};
}

function extractJson<T>(text: string): T | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	return JSON.parse(match[0]) as T;
}

async function callOpenRouter(
	prompt: string,
	apiKey: string,
	maxTokens: number
): Promise<string | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const response = await fetch(OPENROUTER_API, {
			method: 'POST',
			signal: controller.signal,
			headers: { ...OPENROUTER_HEADERS, Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model: AI_MODEL,
				messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
				max_tokens: maxTokens,
				temperature: 0.3,
			}),
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const errorBody = await response.text();
			console.error('[AI] OpenRouter error:', response.status, errorBody);
			return null;
		}

		const data: OpenRouterResponse = await response.json();
		return data.choices?.[0]?.message?.content ?? null;
	} catch (error: unknown) {
		clearTimeout(timeoutId);
		const err = error as Error;
		console.error(`[AI] Request ${err.name === 'AbortError' ? 'timed out' : 'failed'}:`, err.message);
		return null;
	}
}

export async function callGeminiForAnalysis(article: Article, apiKey: string): Promise<AIAnalysisResult> {
	console.log(`[AI] Analyzing: ${article.title.substring(0, 80)}...`);

	const content = article.content ?? article.summary ?? article.title;
	const prompt = `作為一個專業的新聞分析師和翻譯師,請分析以下新聞文章並提供結構化的分析結果,包含英文和中文版本。
文章資訊:
標題: ${article.title}
來源: ${article.source}
摘要: ${article.summary ?? article.summary_cn ?? '無摘要'}
內容: ${content.substring(0, MAX_CONTENT_LENGTH)}...

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

	const rawContent = await callOpenRouter(prompt, apiKey, 800);
	if (!rawContent?.trim()) return createFallbackResult(article);

	console.log('[AI] Response:', rawContent);

	try {
		const result = extractJson<AIAnalysisResult>(rawContent);
		if (!result || !Array.isArray(result.tags) || !Array.isArray(result.keywords) || !result.summary_en || !result.summary_cn) {
			throw new Error('Invalid response format');
		}

		return {
			tags: result.tags.slice(0, 5),
			keywords: result.keywords.slice(0, 8),
			summary_en: result.summary_en,
			summary_cn: result.summary_cn,
			title_en: result.title_en,
			title_cn: result.title_cn,
			category: result.category ?? 'Other',
		};
	} catch (error) {
		console.error('[AI] Parse failed:', error);
		return createFallbackResult(article);
	}
}

interface TweetAnalysis {
	summary_cn: string;
	tags: string[];
	keywords: string[];
}

const TWEET_FALLBACK: TweetAnalysis = { summary_cn: '', tags: ['Twitter'], keywords: [] };

export async function translateTweet(tweetText: string, apiKey: string): Promise<TweetAnalysis> {
	console.log(`[AI] Translating tweet: ${tweetText.substring(0, 60)}...`);

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

	const rawContent = await callOpenRouter(prompt, apiKey, 500);
	if (!rawContent) return { ...TWEET_FALLBACK, summary_cn: tweetText };

	try {
		const result = extractJson<TweetAnalysis>(rawContent);
		if (!result) throw new Error('No JSON found');

		return {
			summary_cn: result.summary_cn ?? tweetText,
			tags: (result.tags ?? ['Twitter']).slice(0, 5),
			keywords: (result.keywords ?? []).slice(0, 8),
		};
	} catch (error) {
		console.error('[AI] Tweet translation failed:', error);
		return { ...TWEET_FALLBACK, summary_cn: tweetText };
	}
}
