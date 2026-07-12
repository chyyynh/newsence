import { generateObject, generateText } from '@core-ai/generation';
import { RESOURCE_CATEGORIES, type ResourceCategory, ZH_HANT_RESOURCE_LANG } from '@core-shared/resource-types';
import { ENTITY_TYPES, type PlatformEnrichments, platformMetadataFor, type ResourceForProcessing } from '@core-shared/types';
import { entityExtractionExclusionNames } from '@entities/normalize';
import { z } from 'zod';

export interface ProcessorResult {
	updateData: {
		tags?: string[];
		keywords?: string[];
		summary?: string;
		content?: string;
		entities?: Array<{ name: string; name_cn: string; type: string }>;
	};
	enrichments?: PlatformEnrichments;
	classificationCategory?: ResourceCategory;
}

export function isEmpty(value: string | null | undefined): boolean {
	return !value?.trim();
}

export type ResourceClassification = {
	tags: string[];
	keywords: string[];
	category: ResourceCategory;
	entities: Array<{ name: string; name_cn: string; type: string }>;
};

export function mergeResourceClassification(
	resource: ResourceForProcessing,
	classification: ResourceClassification,
	options: {
		updateData?: ProcessorResult['updateData'];
		extraTags?: string[];
	} = {},
): { updateData: ProcessorResult['updateData']; classificationCategory?: ResourceCategory } {
	const updateData = options.updateData ?? {};
	const allTags = [...new Set([...classification.tags, classification.category, ...(options.extraTags ?? [])])];

	if (!resource.tags?.length && allTags.length) updateData.tags = allTags;
	if (!resource.keywords?.length && classification.keywords.length) updateData.keywords = classification.keywords;
	if (classification.entities.length) updateData.entities = classification.entities;

	return { updateData, classificationCategory: classification.category };
}

const MAX_CONTENT_LENGTH = 10000;
const MAX_CONTENT_CLEANUP_LENGTH = 12000;
const MIN_CONTENT_CLEANUP_LENGTH = 800;
const CONTENT_TRANSLATION_CHUNK_LENGTH = 6000;
export const DURABLE_CONTENT_TRANSLATION_MAX_CHUNKS = 96;
const MIN_TRANSLATED_CONTENT_RATIO = 0.2;
const PARTIAL_CONTENT_TRANSLATION_RATIO = 0.2;
const MIN_CONTENT_TRANSLATION_LENGTH = 20;
const MIN_TRANSLATABLE_TEXT_LENGTH = 20;
const ExtractedEntitySchema = z.object({
	name: z.string().min(1),
	name_cn: z.string().min(1),
	type: z.enum(ENTITY_TYPES),
});

const ZhHantMetadataTranslationSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
});

const ResourceClassificationSchema = z.object({
	tags: z.array(z.string().min(1)).min(1),
	keywords: z.array(z.string().min(1)).min(1),
	entities: z.array(ExtractedEntitySchema),
	category: z.enum(RESOURCE_CATEGORIES),
});

function zhHantMetadataTranslationSystemPrompt(resource: ResourceForProcessing): string {
	const twitterMetadata = platformMetadataFor(resource, 'twitter');
	const preservesSocialPost = resource.type === 'twitter' && twitterMetadata?.data.variant !== 'longform';
	const summaryInstruction = preservesSocialPost
		? '忠實完整翻譯原貼文或 thread，保留第一人稱、段落與語氣，不要摘要或改寫成新聞報導'
		: '根據原文標題、摘要與內容，產生 1-2 句繁體中文摘要';
	return `你是專業的新聞翻譯和摘要編輯。請只輸出符合 schema 的繁體中文結果。

任務：
- title: 將標題翻譯成自然流暢的繁體中文
- summary: ${summaryInstruction}

規則：
- 忠實保留原文語氣，不要新增資訊
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然繁體中文
- 不要使用 Markdown。`;
}

const RESOURCE_CONTENT_TRANSLATION_SYSTEM_PROMPT = `你是專業的新聞全文翻譯編輯。請將原文完整翻譯成自然流暢的繁體中文。

規則：
- 忠實翻譯原文，不要摘要、不要評論、不要新增資訊
- 你可能只會收到長文的一個分段；只翻譯當前分段，不要補前後文
- 保留 Markdown 結構、標題層級、列表、引用、連結和程式碼區塊
- 專有名詞保留常見英文名稱；必要時可在中文後保留英文
- 若原文已是繁體中文，直接保留原文；若是簡體中文，轉為自然繁體中文
- 直接輸出翻譯後的 Markdown，不要包 code block。`;

const RESOURCE_CONTENT_CLEANUP_SYSTEM_PROMPT = `你是專業的新聞內容清理編輯。請清理抽取出的原文 Markdown，只移除非正文內容。

移除：
- 廣告、贊助、活動宣傳、newsletter/subscribe CTA、cookie/privacy banner
- 導航、頁尾、作者 bio、社群分享提示、推薦閱讀、熱門文章、相關文章列表
- 重複標題、重複段落、圖片版權雜訊、無關的 UI 文案

保留：
- 原文語言，不要翻譯
- 正文內容、必要的小標、列表、引用、連結、程式碼區塊
- 與文章主題直接相關的圖片 markdown

規則：
- 不要摘要、不要改寫、不要新增資訊
- 若內容已乾淨，直接原樣輸出
- 直接輸出清理後 Markdown，不要包 code block，不要解釋。`;

const RESOURCE_CLASSIFICATION_SYSTEM_PROMPT = `你是專業的新聞分類和實體分析師。請只輸出符合 schema 的分類資料。

任務：
- 產生 tags、keywords、category
- 擷取重要 named entities

標籤規則：
- AI相關: AI, MachineLearning, DeepLearning, NLP, ComputerVision, LLM, GenerativeAI
- 產品相關: Coding, VR, AR, Robotics, Automation, SoftwareDevelopment, API
- 產業應用: Tech, Finance, Healthcare, Education, Gaming, Enterprise, Creative
- 事件類型: Funding, IPO, Acquisition, ProductLaunch, Research, Partnership
- 新聞性質: Review, Opinion, Analysis, Feature, Interview, Tutorial, Announcement

實體擷取規則：
- 提取 3-8 個最重要的具名實體；如果文章太短，可以少於 3 個
- type 只能是 person, organization, product, technology, event, location
- name 用英文或原文慣用名稱；name_cn 用繁體中文，若無慣用中文名則與 name 相同
- 不要把文章來源、平台、作者名稱當作實體，除非文章主題就是該來源、平台或作者本身
- 不要提取泛詞、短縮碎片、股票代號或單字母縮寫，例如 AI、X、Go、US、C、RL、PI、$GOOGL
- 模型、產品、活動請使用完整慣用名稱，例如 Claude Opus 4.7、DeepSeek V4、TechCrunch Disrupt 2026
- 如果只能判斷出泛詞、版本碎片或來源名稱，寧可少提取

分類只能是：AI, Tech, Finance, Research, Business, Other。`;

function buildResourceContextPrompt(resource: ResourceForProcessing): string {
	const content = resource.content || resource.summary || resource.title;
	const excludedEntities = entityExtractionExclusionNames(resource.type, resource.source, resource.platform_metadata);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';
	return `文章資訊:
標題: ${resource.title}
來源: ${resource.source}
資源類型: ${resource.type}${excludedLine}
摘要: ${resource.summary || '無摘要'}
內容:
${content.substring(0, MAX_CONTENT_LENGTH)}`;
}

function cjkRatio(text: string): number {
	const letters = text.match(/[A-Za-z\u3400-\u9FFF]/g)?.length ?? 0;
	if (!letters) return 0;
	const cjk = text.match(/[\u3400-\u9FFF]/g)?.length ?? 0;
	return cjk / letters;
}

export function needsZhHantContentTranslation(resource: ResourceForProcessing): boolean {
	const content = resource.content?.trim();
	if (!content || content.length < MIN_CONTENT_TRANSLATION_LENGTH) return false;
	if (!hasTranslatableContent(content)) return false;
	if (resource.original_lang === ZH_HANT_RESOURCE_LANG) return false;
	if (!shouldWriteResourceContentTranslation(resource)) return false;
	return true;
}

export function needsZhHantMetadataTranslation(resource: ResourceForProcessing): boolean {
	if (resource.original_lang === ZH_HANT_RESOURCE_LANG) return false;
	const translation = resource.translations?.[ZH_HANT_RESOURCE_LANG];
	if (translation?.source === 'human') return false;
	return isEmpty(translation?.title) || isEmpty(translation?.summary);
}

export async function generateZhHantMetadataTranslation(
	resource: ResourceForProcessing,
	env: CoreEnv,
): Promise<z.infer<typeof ZhHantMetadataTranslationSchema>> {
	const prompt = `原文資訊：
	資源類型：${resource.type}
	標題：${resource.title}
摘要：${resource.summary || '無摘要'}
內容：
${(resource.content || resource.summary || resource.title).slice(0, MAX_CONTENT_LENGTH)}`;
	const translation = await generateObject(env.AI, prompt, {
		schema: ZhHantMetadataTranslationSchema,
		task: 'resource-metadata-localization',
		gatewayId: env.AI_GATEWAY_NAME,
		maxTokens: 700,
		systemPrompt: zhHantMetadataTranslationSystemPrompt(resource),
	});
	return translation;
}

export function hasTranslatableContent(content: string): boolean {
	const text = content
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, '');
	return text.length >= MIN_TRANSLATABLE_TEXT_LENGTH;
}

function shouldWriteResourceContentTranslation(resource: ResourceForProcessing): boolean {
	const zhHantTranslation = resource.translations?.[ZH_HANT_RESOURCE_LANG];
	if (zhHantTranslation?.source === 'human') return false;
	const zhHantContent = zhHantTranslation?.content;
	if (isEmpty(zhHantContent)) return true;
	const content = resource.content?.trim();
	const translated = zhHantContent?.trim();
	if (!content || !translated || content.length < 1000) return false;
	return translated.length / content.length < PARTIAL_CONTENT_TRANSLATION_RATIO;
}

function normalizeComparableContent(content: string): string {
	return content.replace(/\s+/g, ' ').trim();
}

function looksLikeModelExplanation(content: string): boolean {
	return /^(以下是|這是|Here is|I've cleaned|I cleaned|清理後|已清理)/i.test(content.trim());
}

function validateCleanedContent(original: string, cleaned: string | null): string | null {
	const trimmed = cleaned?.trim();
	if (!trimmed || looksLikeModelExplanation(trimmed)) return null;
	const originalComparable = normalizeComparableContent(original);
	const cleanedComparable = normalizeComparableContent(trimmed);
	if (!cleanedComparable || cleanedComparable === originalComparable) return null;
	if (cleanedComparable.length < Math.max(300, originalComparable.length * 0.25)) return null;
	if (cleanedComparable.length > originalComparable.length * 1.15) return null;
	return trimmed;
}

function splitOversizedBlock(block: string, maxLength: number): string[] {
	const chunks: string[] = [];
	let remaining = block;
	while (remaining.length > maxLength) {
		let cut = remaining.lastIndexOf('\n', maxLength);
		if (cut < Math.floor(maxLength * 0.6)) cut = remaining.lastIndexOf('。', maxLength);
		if (cut < Math.floor(maxLength * 0.6)) cut = remaining.lastIndexOf('. ', maxLength);
		if (cut < Math.floor(maxLength * 0.6)) cut = maxLength;
		chunks.push(remaining.slice(0, cut).trim());
		remaining = remaining.slice(cut).trim();
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

function splitContentForTranslation(content: string): string[] {
	const chunks: string[] = [];
	let current = '';
	const pushCurrent = () => {
		const trimmed = current.trim();
		if (trimmed) chunks.push(trimmed);
		current = '';
	};

	for (const block of content.split(/\n{2,}/)) {
		const trimmedBlock = block.trim();
		if (!trimmedBlock) continue;
		if (trimmedBlock.length > CONTENT_TRANSLATION_CHUNK_LENGTH) {
			pushCurrent();
			chunks.push(...splitOversizedBlock(trimmedBlock, CONTENT_TRANSLATION_CHUNK_LENGTH));
			continue;
		}
		const next = current ? `${current}\n\n${trimmedBlock}` : trimmedBlock;
		if (next.length > CONTENT_TRANSLATION_CHUNK_LENGTH) {
			pushCurrent();
			current = trimmedBlock;
		} else {
			current = next;
		}
	}
	pushCurrent();
	return chunks;
}

function validateTranslatedContent(original: string, translated: string | null): string | null {
	const trimmed = translated?.trim();
	if (!trimmed || looksLikeModelExplanation(trimmed)) return null;
	if (original.length >= 1000 && cjkRatio(original) < 0.6 && trimmed.length < original.length * MIN_TRANSLATED_CONTENT_RATIO) return null;
	return trimmed;
}

function contentTranslationPrompt(chunk: string, index: number, total: number): string {
	return `原文 Markdown（第 ${index + 1}/${total} 段）:\n${chunk}`;
}

export class ContentTranslationLimitError extends Error {
	constructor(contentLength: number, chunks: number, maxChunks: number) {
		super(`Content translation requires ${chunks} chunks for ${contentLength} characters; limit is ${maxChunks} chunks`);
		this.name = 'ContentTranslationLimitError';
	}
}

export function createZhHantContentTranslationChunks(content: string, maxChunks: number): string[] {
	const source = content.trim();
	const chunks = splitContentForTranslation(source);
	if (chunks.length > maxChunks) throw new ContentTranslationLimitError(source.length, chunks.length, maxChunks);
	return chunks;
}

export async function translateZhHantContentChunk(chunk: string, index: number, total: number, env: CoreEnv): Promise<string> {
	const translated = await generateText(env.AI, contentTranslationPrompt(chunk, index, total), {
		task: 'resource-content-translation',
		gatewayId: env.AI_GATEWAY_NAME,
		maxTokens: 8000,
		temperature: 0.2,
		systemPrompt: RESOURCE_CONTENT_TRANSLATION_SYSTEM_PROMPT,
	});
	const validated = validateTranslatedContent(chunk, translated);
	if (!validated) throw new Error(`Content translation chunk ${index + 1}/${total} did not return valid output`);
	return validated;
}

export function assembleZhHantContentTranslation(original: string, translatedChunks: string[]): string {
	const translated = validateTranslatedContent(original.trim(), translatedChunks.join('\n\n'));
	if (!translated) throw new Error('Assembled content translation did not pass validation');
	return translated;
}

async function generateResourceContentCleanup(resource: ResourceForProcessing, env: CoreEnv): Promise<string | null> {
	const content = resource.content?.trim();
	if (!content || content.length < MIN_CONTENT_CLEANUP_LENGTH || resource.type === 'youtube' || resource.type === 'hackernews') return null;
	const cleanupContent = content.slice(0, MAX_CONTENT_CLEANUP_LENGTH);
	const cleaned = await generateText(env.AI, `原文 Markdown:\n${cleanupContent}`, {
		task: 'resource-content-cleanup',
		gatewayId: env.AI_GATEWAY_NAME,
		maxTokens: 6000,
		temperature: 0.1,
		systemPrompt: RESOURCE_CONTENT_CLEANUP_SYSTEM_PROMPT,
	});
	return validateCleanedContent(cleanupContent, cleaned);
}

export async function generateResourceClassification(resource: ResourceForProcessing, env: CoreEnv): Promise<ResourceClassification> {
	console.info({ tag: 'AI', msg: 'Analyzing', title: resource.title.substring(0, 80) });

	try {
		const cleanedContent = await generateResourceContentCleanup(resource, env).catch((error) => {
			console.error({ tag: 'AI', msg: 'Resource content cleanup failed', error: String(error) });
			return null;
		});
		const resourceForAnalysis = cleanedContent ? { ...resource, content: cleanedContent } : resource;
		const resourcePrompt = buildResourceContextPrompt(resourceForAnalysis);
		const classification = await generateObject(env.AI, resourcePrompt, {
			schema: ResourceClassificationSchema,
			task: 'resource-classification',
			gatewayId: env.AI_GATEWAY_NAME,
			maxTokens: 500,
			systemPrompt: RESOURCE_CLASSIFICATION_SYSTEM_PROMPT,
		});
		return {
			tags: classification.tags.slice(0, 5),
			keywords: classification.keywords.slice(0, 8),
			category: classification.category,
			entities: classification.entities.slice(0, 10),
		};
	} catch (error) {
		console.error({ tag: 'AI', msg: 'Analysis failed', error: String(error) });
		throw error;
	}
}
