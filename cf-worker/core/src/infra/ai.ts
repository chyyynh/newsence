import { Article, AIAnalysisResult, OpenRouterResponse } from '../models/types';
import { logInfo, logError } from './log';

// ─────────────────────────────────────────────────────────────
// Content Assessment Types
// ─────────────────────────────────────────────────────────────

interface ContentInput {
	title?: string;
	text: string;
	url: string;
	source: string;
	sourceType: 'twitter' | 'rss' | 'hackernews';
	links?: string[];
	metrics?: {
		viewCount?: number;
		likeCount?: number;
	};
}

interface ContentAssessment {
	action: 'save' | 'follow_link' | 'discard';
	score: number;
	reason: string;
	contentType: 'original_content' | 'link_share' | 'discussion' | 'announcement';
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = 60_000;
const MAX_CONTENT_LENGTH = 2000;

const OPENROUTER_HEADERS = {
	'Content-Type': 'application/json',
	'HTTP-Referer': 'https://app.newsence.xyz',
	'X-Title': 'app.newsence.xyz',
};

// Available models
export const AI_MODELS = {
	FLASH_LITE: 'google/gemini-2.5-flash-lite',
	FLASH: 'google/gemini-3-flash-preview',
} as const;

// ─────────────────────────────────────────────────────────────
// Core API Functions
// ─────────────────────────────────────────────────────────────

interface CallOpenRouterOptions {
	apiKey: string;
	model?: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	timeoutMs?: number;
}

/**
 * Unified OpenRouter API call
 */
export async function callOpenRouter(
	prompt: string,
	options: CallOpenRouterOptions
): Promise<string | null> {
	const {
		apiKey,
		model = AI_MODELS.FLASH,
		maxTokens,
		temperature = 0.3,
		systemPrompt,
		timeoutMs = TIMEOUT_MS,
	} = options;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const messages = systemPrompt
		? [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: prompt },
		  ]
		: [{ role: 'user', content: [{ type: 'text', text: prompt }] }];

	try {
		const response = await fetch(OPENROUTER_API, {
			method: 'POST',
			signal: controller.signal,
			headers: { ...OPENROUTER_HEADERS, Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				messages,
				...(maxTokens != null && { max_tokens: maxTokens }),
				temperature,
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			logError('AI', 'OpenRouter error', { status: response.status, body: errorBody });
			return null;
		}

		const data: OpenRouterResponse = await response.json();
		return data.choices?.[0]?.message?.content ?? null;
	} catch (error: unknown) {
		const err = error as Error;
		logError('AI', 'Request failed', { type: err.name === 'AbortError' ? 'timeout' : 'error', error: err.message });
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

export function extractJson<T>(text: string): T | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return JSON.parse(match[0]) as T;
	} catch {
		return null;
	}
}

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

// ─────────────────────────────────────────────────────────────
// High-level Analysis Functions
// ─────────────────────────────────────────────────────────────

export async function callGeminiForAnalysis(article: Article, apiKey: string): Promise<AIAnalysisResult> {
	logInfo('AI', 'Analyzing', { title: article.title.substring(0, 80) });

	const content = article.content || article.summary || article.title;
	const prompt = `作為一個專業的新聞分析師和翻譯師,請分析以下新聞文章並提供結構化的分析結果,包含英文和中文版本。
文章資訊:
標題: ${article.title}
來源: ${article.source}
摘要: ${article.summary || article.summary_cn || '無摘要'}
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
- summary_cn: 用繁體中文直接翻譯摘要，保持原文語氣和人稱，不要改寫成第三人稱描述
- 所有翻譯結果不要使用 Markdown 格式（不要用 **粗體**、- 列表、# 標題等），純文字即可

標籤規則:
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

分類選項: AI, Tech, Finance, Research, Business, Other

請只回傳JSON,不要其他文字。`;

	const rawContent = await callOpenRouter(prompt, { apiKey, maxTokens: 800 });
	if (!rawContent?.trim()) return createFallbackResult(article);

	logInfo('AI', 'Response', { content: rawContent });

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
		logError('AI', 'Parse failed', { error: String(error) });
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
	logInfo('AI', 'Translating tweet', { text: tweetText.substring(0, 60) });

	const prompt = `請將以下推文直接翻譯成繁體中文，並提供標籤和關鍵字。

翻譯規則：
- 直接翻譯原文，保持原文的第一人稱或語氣，不要改寫成第三人稱描述
- 不要用「這則推文」、「作者認為」、「該推文提到」等第三角度描述
- 不要使用任何 Markdown 格式（不要用 **粗體**、- 列表、# 標題等）
- 純文字翻譯，忠實呈現原文意思即可

推文內容：
${tweetText}

請以JSON格式回答：
{
  "summary_cn": "繁體中文直接翻譯",
  "tags": ["標籤1", "標籤2", "標籤3"],
  "keywords": ["關鍵字1", "關鍵字2", "關鍵字3"]
}

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, LLM, GenerativeAI
- 產品相關: Coding, Robotics, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Gaming, Creative
- 事件類型: ProductLaunch, Research, Partnership, Announcement

請只回傳JSON，不要其他文字。`;

	const rawContent = await callOpenRouter(prompt, { apiKey });
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
		logError('AI', 'Tweet translation failed', { error: String(error) });
		return { ...TWEET_FALLBACK, summary_cn: tweetText };
	}
}

// ─────────────────────────────────────────────────────────────
// Content Assessment
// ─────────────────────────────────────────────────────────────

const CONTENT_ASSESSMENT_PROMPT = `你是內容品質評估專家。判斷這則內容應該如何處理。

【內容資訊】
來源: {source}
類型: {sourceType}
標題: {title}
文字長度: {textLength} 字
文字內容: {text}
包含連結: {links}
互動數據: viewCount={viewCount}, likeCount={likeCount}

【判斷標準】

1. save (直接儲存) - 分數 >= 60
   - 有實質內容 (>100字有意義的文字)
   - 原創分析、技術討論、官方公告
   - 包含具體數據、研究結果、技術細節

2. follow_link (抓取連結內容) - 分數 40-59
   - 文字很短但分享了可能有價值的連結
   - 例如: "這篇很棒: [連結]"、"重要更新: [連結]"
   - 連結不是社群媒體 (twitter/instagram/tiktok)

3. discard (丟棄) - 分數 < 40
   - 純宣傳無實質內容 ("試試 X！")
   - 語意不明、低品質
   - 連結是其他社群媒體
   - 重複/垃圾內容

【評分維度】
- 內容完整性 (0-40): 有實質內容得高分
- 信息價值 (0-35): 有具體數據/分析得高分
- 來源可信度 (0-25): 官方/知名來源得高分

【回傳 JSON】
{
  "action": "save" | "follow_link" | "discard",
  "score": 0-100,
  "reason": "簡短說明 (20字內)",
  "contentType": "original_content" | "link_share" | "discussion" | "announcement"
}

只回傳 JSON，不要其他文字。`;

const DEFAULT_ASSESSMENT: ContentAssessment = {
	action: 'save',
	score: 50,
	reason: 'AI evaluation failed, default save',
	contentType: 'original_content',
};

export async function assessContent(input: ContentInput, apiKey: string): Promise<ContentAssessment> {
	logInfo('AI', 'Assessing', { title: input.title?.substring(0, 50) ?? input.text.substring(0, 50) });

	const prompt = CONTENT_ASSESSMENT_PROMPT
		.replace('{source}', input.source)
		.replace('{sourceType}', input.sourceType)
		.replace('{title}', input.title ?? 'N/A')
		.replace('{textLength}', String(input.text.length))
		.replace('{text}', input.text.substring(0, 1000))
		.replace('{links}', input.links?.join(', ') ?? 'None')
		.replace('{viewCount}', String(input.metrics?.viewCount ?? 'N/A'))
		.replace('{likeCount}', String(input.metrics?.likeCount ?? 'N/A'));

	const rawContent = await callOpenRouter(prompt, { apiKey, maxTokens: 200, temperature: 0.1 });
	if (!rawContent) return DEFAULT_ASSESSMENT;

	try {
		const result = extractJson<ContentAssessment>(rawContent);
		if (!result || !result.action || typeof result.score !== 'number') {
			throw new Error('Invalid assessment format');
		}

		logInfo('AI', 'Assessment result', { action: result.action, score: result.score, reason: result.reason });
		return {
			action: result.action,
			score: result.score,
			reason: result.reason ?? '',
			contentType: result.contentType ?? 'original_content',
		};
	} catch (error) {
		logError('AI', 'Assessment parse failed', { error: String(error) });
		return DEFAULT_ASSESSMENT;
	}
}
