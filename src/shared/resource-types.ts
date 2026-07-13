export const CONTENT_RESOURCE_TYPES = ['web', 'rss', 'twitter', 'youtube', 'hackernews', 'pdf'] as const;

export type ContentResourceType = (typeof CONTENT_RESOURCE_TYPES)[number];

const MEDIA_RESOURCE_TYPES = ['image', 'file'] as const;

export const RESOURCE_TYPES = [...CONTENT_RESOURCE_TYPES, ...MEDIA_RESOURCE_TYPES] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export function isContentResourceType(value: unknown): value is ContentResourceType {
	return typeof value === 'string' && (CONTENT_RESOURCE_TYPES as readonly string[]).includes(value);
}

export function isResourceType(value: unknown): value is ResourceType {
	return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

export const RESOURCE_ORIGINAL_CONTENT_TYPES = ['web', 'rss', 'twitter', 'hackernews'] as const satisfies readonly ContentResourceType[];

export const SOURCE_PLATFORMS = ['rss', 'twitter', 'youtube'] as const satisfies readonly ContentResourceType[];

export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export const SOURCE_ACQUISITION_MODES = ['platform', 'web', 'feed'] as const;

export type SourceAcquisitionMode = (typeof SOURCE_ACQUISITION_MODES)[number];

export const RESOURCE_SCOPES = ['corpus', 'private'] as const;

export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export type ResourceContentSurface = 'app' | 'ai-tools' | 'export';

export function hasResourceContentAccess(input: {
	surface: ResourceContentSurface;
	hasViewer: boolean;
	scope: string;
	inViewerLibrary: boolean;
}): boolean {
	if (!input.hasViewer) return false;
	// AI and exports stay library-gated so stored or paywalled corpus content is
	// not redistributed by default.
	return input.inViewerLibrary || (input.scope === 'corpus' && input.surface === 'app');
}

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

export function targetResourceLocale(requestedLocale: string | null | undefined, originalLang: string | null | undefined): string | null {
	return canonicalizeOptionalResourceLang(requestedLocale) ?? canonicalizeOptionalResourceLang(originalLang);
}

export function selectPreferredResourceTranslation<T extends { lang: string }>(
	translations: readonly T[],
	requestedLocale: string | null | undefined,
	originalLang: string | null | undefined,
): T | null {
	const byLocale = new Map<string, T>();
	for (const translation of translations) {
		const locale = canonicalizeOptionalResourceLang(translation.lang);
		if (locale && !byLocale.has(locale)) byLocale.set(locale, translation);
	}
	const requested = canonicalizeOptionalResourceLang(requestedLocale);
	const original = canonicalizeOptionalResourceLang(originalLang);
	return (requested ? byLocale.get(requested) : null) ?? (original ? byLocale.get(original) : null) ?? null;
}

export const RESOURCE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const RESOURCE_TRANSLATION_SOURCES = ['original', 'machine', 'human'] as const;

export type ResourceTranslationSource = (typeof RESOURCE_TRANSLATION_SOURCES)[number];
