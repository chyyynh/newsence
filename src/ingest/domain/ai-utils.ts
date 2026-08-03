import { generateObject, generateText } from '@core-ai/generation';
import { RESOURCE_CATEGORIES, type ResourceCategory, ZH_HANT_RESOURCE_LANG } from '@core-shared/resource-types';
import { ENTITY_TYPES, type ResourceForProcessing } from '@core-shared/types';
import { entityExtractionExclusionNames, type ResourceEntityInput } from '@entities/normalize';
import { z } from 'zod';

export interface ProcessorResult {
	tags?: string[];
	keywords?: string[];
	content?: string;
	entities: ResourceEntityInput[];
	category: ResourceCategory;
}

function isEmpty(value: string | null | undefined): boolean {
	return !value?.trim();
}

const MAX_CONTENT_LENGTH = 10000;
/**
 * Ceiling for translating a body in one call. Measured on qwen3-30b: ~0.165
 * input and ~0.29 output tokens per source character at ~108 output tokens/s,
 * so 36k characters is ~18k of the 32k context and ~97s against the 180s step
 * timeout. It covers 98% of the corpus; longer bodies (overwhelmingly Hacker
 * News comment dumps) keep their original text instead of being split up.
 */
export const CONTENT_TRANSLATION_MAX_LENGTH = 36000;
const PARTIAL_CONTENT_TRANSLATION_RATIO = 0.2;
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

const ZhHantTitleTranslationSchema = z.object({
	title: z.string().min(1),
});

const ZhHantTwitterTranslationSchema = z.object({
	title: z.string().min(1),
	content: z.string().min(1),
});

const ResourceClassificationSchema = z.object({
	tags: z.array(z.string().min(1)).min(1),
	keywords: z.array(z.string().min(1)).min(1),
	entities: z.array(ExtractedEntitySchema),
	category: z.enum(RESOURCE_CATEGORIES),
});

const INLINE_TWITTER_CONTENT_TRANSLATION_MAX_LENGTH = 1000;

function usesInlineTwitterContentTranslation(resource: ResourceForProcessing): boolean {
	const content = resource.content?.trim();
	return resource.resource_platform === 'twitter' && !!content && content.length <= INLINE_TWITTER_CONTENT_TRANSLATION_MAX_LENGTH;
}

function zhHantMetadataTranslationSystemPrompt(resource: ResourceForProcessing, includeContent = false): string {
	if (resource.resource_platform === 'twitter') {
		return `你是專業的新聞翻譯編輯。請只輸出符合 schema 的繁體中文結果。

任務：
- title: 將標題翻譯成自然流暢的繁體中文
${includeContent ? '- content: 將完整貼文內容翻譯成自然流暢的繁體中文，不要摘要' : ''}

規則：
- 忠實保留原文語氣，不要新增資訊
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然繁體中文
- 不要使用 Markdown。`;
	}
	return `你是專業的新聞翻譯和摘要編輯。請只輸出符合 schema 的繁體中文結果。

任務：
- title: 將標題翻譯成自然流暢的繁體中文
- summary: 根據原文標題、摘要與內容，產生 1-2 句繁體中文摘要

規則：
- 忠實保留原文語氣，不要新增資訊
- 若原文已是繁體中文，保留自然表達；若是簡體中文，轉為自然繁體中文
- 不要使用 Markdown。`;
}

const RESOURCE_CONTENT_TRANSLATION_SYSTEM_PROMPT = `你是專業的新聞全文翻譯編輯。請將原文完整翻譯成自然流暢的繁體中文。

規則：
- 忠實翻譯原文，不要摘要、不要評論、不要新增資訊
- 保留 Markdown 結構、標題層級、列表、引用、連結和程式碼區塊
- 專有名詞保留常見英文名稱；必要時可在中文後保留英文
- 若原文已是繁體中文，直接保留原文；若是簡體中文，轉為自然繁體中文
- 直接輸出翻譯後的 Markdown，不要包 code block。`;

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
	const content = requiredResourceContent(resource);
	const source = requiredResourceSource(resource);
	const excludedEntities = entityExtractionExclusionNames(resource.resource_platform, resource.source, resource.platform_metadata);
	const excludedLine = excludedEntities.length ? `\n實體排除名單: ${excludedEntities.join(', ')}` : '';
	const summaryLine = resource.summary?.trim() ? `\n摘要: ${resource.summary.trim()}` : '';
	return `文章資訊:
標題: ${resource.title}
來源: ${source}
資源種類: ${resource.kind}
資源平台: ${resource.resource_platform ?? 'none'}${excludedLine}${summaryLine}
內容:
${content.substring(0, MAX_CONTENT_LENGTH)}`;
}

function requiredResourceSource(resource: ResourceForProcessing): string {
	const source = resource.source?.trim();
	if (!source) throw new Error(`Resource ${resource.id} has no source`);
	return source;
}

function requiredResourceContent(resource: ResourceForProcessing): string {
	const content = resource.content?.trim();
	if (!content) throw new Error(`Resource ${resource.id} has no content`);
	return content;
}

export function needsZhHantContentTranslation(resource: ResourceForProcessing): boolean {
	const content = resource.content?.trim();
	if (!content) return false;
	if (!hasTranslatableContent(content)) return false;
	if (resource.original_lang === ZH_HANT_RESOURCE_LANG) return false;
	if (!shouldWriteResourceContentTranslation(resource)) return false;
	if (content.length > CONTENT_TRANSLATION_MAX_LENGTH) {
		console.info({
			tag: 'RESOURCE_TRANSLATION',
			msg: 'Body too long to translate in one call; keeping the original',
			resource_id: resource.id,
			chars: content.length,
			limit: CONTENT_TRANSLATION_MAX_LENGTH,
		});
		return false;
	}
	return true;
}

export function needsZhHantMetadataTranslation(resource: ResourceForProcessing): boolean {
	if (resource.original_lang === ZH_HANT_RESOURCE_LANG) return false;
	const translation = resource.translations[ZH_HANT_RESOURCE_LANG];
	if (translation?.source === 'human') return false;
	if (resource.resource_platform === 'twitter') {
		return isEmpty(translation?.title) || (usesInlineTwitterContentTranslation(resource) && isEmpty(translation?.content));
	}
	return isEmpty(translation?.title) || isEmpty(translation?.summary);
}

export async function generateZhHantMetadataTranslation(
	resource: ResourceForProcessing,
	env: CoreEnv,
): Promise<
	| z.infer<typeof ZhHantMetadataTranslationSchema>
	| z.infer<typeof ZhHantTitleTranslationSchema>
	| z.infer<typeof ZhHantTwitterTranslationSchema>
> {
	const content = requiredResourceContent(resource);
	const summaryLine = resource.summary?.trim() ? `\n摘要：${resource.summary.trim()}` : '';
	const prompt = `原文資訊：
	資源種類：${resource.kind}
	資源平台：${resource.resource_platform ?? 'none'}
	標題：${resource.title}${summaryLine}
內容：
${content.slice(0, MAX_CONTENT_LENGTH)}`;
	const context = { feature: 'resource-metadata-localization', resourceId: resource.id };
	if (resource.resource_platform === 'twitter') {
		if (usesInlineTwitterContentTranslation(resource)) {
			return generateObject(env, prompt, {
				...context,
				schema: ZhHantTwitterTranslationSchema,
				maxTokens: 2400,
				systemPrompt: zhHantMetadataTranslationSystemPrompt(resource, true),
			});
		}
		return generateObject(env, prompt, {
			...context,
			schema: ZhHantTitleTranslationSchema,
			maxTokens: 400,
			systemPrompt: zhHantMetadataTranslationSystemPrompt(resource),
		});
	}
	return generateObject(env, prompt, {
		...context,
		schema: ZhHantMetadataTranslationSchema,
		maxTokens: 700,
		systemPrompt: zhHantMetadataTranslationSystemPrompt(resource),
	});
}

export function hasTranslatableContent(content: string): boolean {
	const text = content
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, '');
	return text.length >= MIN_TRANSLATABLE_TEXT_LENGTH;
}

function shouldWriteResourceContentTranslation(resource: ResourceForProcessing): boolean {
	const zhHantTranslation = resource.translations[ZH_HANT_RESOURCE_LANG];
	if (zhHantTranslation?.source === 'human') return false;
	const zhHantContent = zhHantTranslation?.content;
	if (isEmpty(zhHantContent)) return true;
	const content = resource.content?.trim();
	const translated = zhHantContent?.trim();
	if (!content || !translated || content.length < 1000) return false;
	return translated.length / content.length < PARTIAL_CONTENT_TRANSLATION_RATIO;
}

export async function translateZhHantContent(content: string, env: CoreEnv, resourceId: string): Promise<string> {
	return generateText(env, `原文 Markdown:\n${content.trim()}`, {
		feature: 'resource-content-translation',
		resourceId,
		// Measured on real bodies: ~0.31 output tokens per source character, so a
		// 36k-character body lands near 11.1k. Leave room above that — the
		// finish_reason guard turns a clipped response into a failed translation,
		// so this cap must not be reachable by an in-policy body.
		maxTokens: 16000,
		temperature: 0.2,
		systemPrompt: RESOURCE_CONTENT_TRANSLATION_SYSTEM_PROMPT,
	});
}

export async function classifyResource(resource: ResourceForProcessing, env: CoreEnv, extraTags: string[] = []): Promise<ProcessorResult> {
	console.info({ tag: 'AI', msg: 'Analyzing', title: resource.title.substring(0, 80) });

	const resourcePrompt = buildResourceContextPrompt(resource);
	const classification = await generateObject(env, resourcePrompt, {
		feature: 'resource-classification',
		resourceId: resource.id,
		schema: ResourceClassificationSchema,
		maxTokens: 500,
		systemPrompt: RESOURCE_CLASSIFICATION_SYSTEM_PROMPT,
	});
	const tags = classification.tags.slice(0, 5);
	const keywords = classification.keywords.slice(0, 8);
	return {
		category: classification.category,
		entities: classification.entities.slice(0, 10),
		...(!resource.tags.length ? { tags: [...new Set([...tags, classification.category, ...extraTags])] } : {}),
		...(!resource.keywords.length && keywords.length ? { keywords } : {}),
	};
}
