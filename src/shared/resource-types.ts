export const RESOURCE_TYPES = ['web', 'rss', 'twitter', 'youtube', 'hackernews', 'pdf', 'paper', 'image', 'file'] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export function isResourceType(value: unknown): value is ResourceType {
	return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

export const RESOURCE_SCOPES = ['corpus', 'private'] as const;

export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export const DEFAULT_RESOURCE_LANG = 'en';

export const ZH_HANT_RESOURCE_LANG = 'zh-Hant';

const RESOURCE_LANG_MAX_LENGTH = 35;

export function canonicalizeResourceLang(value: unknown): string {
	if (typeof value !== 'string') throw new Error(`Invalid resource language: ${String(value)}`);
	const lang = value.trim();
	if (!lang || lang.length > RESOURCE_LANG_MAX_LENGTH) throw new Error(`Invalid resource language: ${value}`);

	try {
		const canonical = Intl.getCanonicalLocales(lang)[0];
		if (!canonical || canonical.length > RESOURCE_LANG_MAX_LENGTH) throw new Error('Invalid locale');
		return canonical;
	} catch {
		throw new Error(`Invalid resource language: ${value}`);
	}
}

export function canonicalizeOptionalResourceLang(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const lang = value.trim().replaceAll('_', '-');
	if (!lang || lang.toLowerCase() === 'und') return null;
	try {
		return canonicalizeResourceLang(lang);
	} catch {
		return null;
	}
}

export const RESOURCE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const RESOURCE_TRANSLATION_SOURCES = ['original', 'machine', 'human'] as const;

export type ResourceTranslationSource = (typeof RESOURCE_TRANSLATION_SOURCES)[number];
