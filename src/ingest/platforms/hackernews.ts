import { generateText } from '@core-ai/embedding';
import type { PlatformEnrichments } from '@core-shared/platform-metadata';
import type { Article } from '@core-shared/types';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { generateArticleAnalysis, mergeArticleAnalysis, type ProcessorResult } from '../domain/ai-utils';

const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';

interface HnComment {
	author?: string;
	text?: string;
	children?: HnComment[];
}

interface HnItem {
	id: number;
	title?: string;
	url?: string;
	text?: string;
	children?: HnComment[];
}

async function fetchHnItem(itemId: string): Promise<HnItem> {
	const response = await fetchWithTimeout(`${HN_ALGOLIA_API}/${itemId}`);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	return JSON.parse(await readTextWithLimit(response)) as HnItem;
}

interface HnCollectedComment {
	author?: string;
	text: string;
}

function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&#x2F;/g, '/')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

function htmlToText(str: string): string {
	return decodeHtmlEntities(str.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

function collectAllComments(children: HnComment[]): HnCollectedComment[] {
	const comments: HnCollectedComment[] = [];
	for (const child of children) {
		if (child.text) {
			const cleanText = htmlToText(child.text);
			if (cleanText) comments.push({ author: child.author, text: cleanText });
		}
		if (child.children?.length) comments.push(...collectAllComments(child.children));
	}
	return comments;
}

function extractPostLinks(externalUrl?: string | null, hnTextHtml?: string | null): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	if (externalUrl) {
		seen.add(externalUrl);
		urls.push(externalUrl);
	}
	if (hnTextHtml) {
		const hrefMatches = hnTextHtml.match(/href="([^"]+)"/g);
		for (const match of hrefMatches ?? []) {
			const raw = decodeHtmlEntities(match.slice(6, -1));
			if (!seen.has(raw) && raw.startsWith('http')) {
				seen.add(raw);
				urls.push(raw);
			}
		}
	}
	return urls;
}

interface EditorialPrompts {
	system: string;
	instruction: string;
	rules: string[];
}

const EDITORIAL_CN: EditorialPrompts = {
	system: '你是一位專業的科技新聞編輯，負責將 Hacker News 討論串整理成深度筆記。只使用提供的素材，直接輸出繁體中文 Markdown。',
	instruction: `請用繁體中文撰寫 500-800 字的整理筆記，用段落式敘述，不要用條列式重點。格式：

## 背景
2-3 句介紹文章脈絡，讓沒看過原文的人快速了解在討論什麼。

## 社群觀點
最重要的部分。用連貫的段落整理 HN 留言者的觀點，包括主要的支持與反對意見、有趣的補充觀點、值得注意的爭論或共識。像寫一篇短評一樣自然地串接不同觀點。

## 延伸閱讀
留言中提到的有價值的資源、工具、連結。沒有就省略此段。`,
	rules: [
		'繁體中文，嚴禁簡體',
		'不要使用任何 emoji',
		'重點是社群怎麼看，不是複述原文',
		'引用留言觀點做歸納，不逐字翻譯',
		'語氣中立客觀但不死板',
		'直接輸出 Markdown，不要包在 code block 裡',
	],
};

const EDITORIAL_EN: EditorialPrompts = {
	system:
		'You are a professional tech news editor. Summarize Hacker News discussions into in-depth editorial notes. Use only the provided material. Output Markdown directly.',
	instruction: `Write a 400-600 word editorial note in English using flowing paragraphs, not bullet points. Format:

## Background
2-3 sentences of context so a reader unfamiliar with the article can quickly understand what is being discussed.

## Community Perspectives
The most important section. Summarize HN commenters' viewpoints in coherent paragraphs — major arguments for and against, interesting supplementary perspectives, and notable debates or consensus. Weave different viewpoints together naturally, like a short commentary piece.

## Further Reading
Valuable resources, tools, or links mentioned in the comments. Omit this section if none.`,
	rules: [
		'Write in English',
		'Do not use any emoji',
		'Focus on how the community reacted, not restating the article',
		'Synthesize and paraphrase commenter opinions — do not translate verbatim',
		'Maintain a neutral, objective but engaging tone',
		'Output Markdown directly, do not wrap in a code block',
	],
};

function buildEditorialPrompt(
	prompts: EditorialPrompts,
	title: string,
	hnText: string,
	commentInput: string,
	commentCount: number,
): { system: string; user: string } {
	const rulesBlock = prompts.rules.map((rule) => `- ${rule}`).join('\n');
	const user = `Title: ${title}
HN post text:
${htmlToText(hnText).slice(0, 1200) || 'N/A'}

HN comments (${commentCount} total):
${commentInput}

${prompts.instruction}

Rules:
${rulesBlock}`;
	return { system: prompts.system, user };
}

async function generateHnEditorial(
	env: CoreEnv,
	title: string,
	hnText: string,
	comments: HnCollectedComment[],
): Promise<{ en: string | null; cn: string | null }> {
	if (comments.length < 4) return { en: null, cn: null };

	const commentInput = comments
		.map((comment) => `${comment.author ? `${comment.author}: ` : ''}${comment.text}`)
		.join('\n')
		.slice(0, 30000);

	const cnPrompt = buildEditorialPrompt(EDITORIAL_CN, title, hnText, commentInput, comments.length);
	const enPrompt = buildEditorialPrompt(EDITORIAL_EN, title, hnText, commentInput, comments.length);

	const [cn, en] = await Promise.all([
		generateText(env.AI, cnPrompt.user, { systemPrompt: cnPrompt.system, task: 'hn-editorial-cn', gatewayId: env.AI_GATEWAY_NAME }),
		generateText(env.AI, enPrompt.user, { systemPrompt: enPrompt.system, task: 'hn-editorial-en', gatewayId: env.AI_GATEWAY_NAME }),
	]);

	return { en, cn };
}

export async function processHackerNewsArticle(article: Article, env: CoreEnv): Promise<ProcessorResult> {
	const metadata = article.platform_metadata;
	const itemId = metadata?.type === 'hackernews' ? metadata.data.itemId || null : null;

	const hnData: HnItem | null = itemId
		? await fetchHnItem(itemId).catch((error) => {
				console.error({ tag: 'HN-PROCESSOR', msg: 'Failed to fetch HN data', error: String(error) });
				return null;
			})
		: null;

	const comments = hnData?.children?.length ? collectAllComments(hnData.children) : [];

	const editorial = hnData ? await generateHnEditorial(env, article.title, hnData.text || '', comments) : null;
	const updateData: ProcessorResult['updateData'] = {
		...(editorial?.cn ? { content_cn: editorial.cn } : {}),
		...(editorial?.en ? { content: editorial.en } : {}),
	};

	const enrichments: PlatformEnrichments = hnData
		? {
				hnUrl: `https://news.ycombinator.com/item?id=${hnData.id}`,
				externalUrl: hnData.url || null,
				hnText: hnData.text || null,
				commentCount: comments.length,
				links: extractPostLinks(hnData.url, hnData.text),
			}
		: {};

	const analysis = await generateArticleAnalysis(article, env);
	const merged = mergeArticleAnalysis(article, analysis, {
		updateData,
		extraTags: ['HackerNews'],
		overwriteSummary: true,
		includeContent: false,
	});

	return { updateData: merged.updateData, enrichments, classificationCategory: merged.classificationCategory };
}
