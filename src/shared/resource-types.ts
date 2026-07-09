export const RESOURCE_TYPES = ['web', 'rss', 'twitter', 'youtube', 'hackernews', 'pdf', 'paper', 'image', 'file'] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export function isResourceType(value: unknown): value is ResourceType {
	return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

export const RESOURCE_SCOPES = ['corpus', 'private'] as const;

export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export const DEFAULT_RESOURCE_LANG = 'en';

export const ZH_HANT_RESOURCE_LANG = 'zh-Hant';

export const RESOURCE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const RESOURCE_TRANSLATION_SOURCES = ['original', 'machine', 'human'] as const;

export type ResourceTranslationSource = (typeof RESOURCE_TRANSLATION_SOURCES)[number];
