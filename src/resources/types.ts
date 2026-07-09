export const RESOURCE_TYPES = ['web', 'rss', 'twitter', 'youtube', 'hackernews', 'pdf', 'paper', 'image', 'file'] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const RESOURCE_TRANSLATION_SOURCES = ['original', 'machine', 'human'] as const;

export type ResourceTranslationSource = (typeof RESOURCE_TRANSLATION_SOURCES)[number];
