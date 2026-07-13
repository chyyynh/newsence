export {
	CONTENT_RESOURCE_TYPES,
	type ContentResourceType,
	isContentResourceType,
	isResourceType,
	RESOURCE_TYPES,
	type ResourceType,
} from '@resource-types';

import type { ContentResourceType } from '@resource-types';

export const RESOURCE_ORIGINAL_CONTENT_TYPES = ['web', 'rss', 'twitter', 'hackernews'] as const satisfies readonly ContentResourceType[];

export const SOURCE_PLATFORMS = ['rss', 'twitter', 'youtube'] as const satisfies readonly ContentResourceType[];

export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export const SOURCE_ACQUISITION_MODES = ['platform', 'web', 'feed'] as const;

export type SourceAcquisitionMode = (typeof SOURCE_ACQUISITION_MODES)[number];

export const RESOURCE_SCOPES = ['corpus', 'private'] as const;

export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export type ResourceContentSurface = 'app' | 'ai-tools' | 'export';

// AI and exports stay library-gated so stored or paywalled corpus content is
// not redistributed by default.
export function resourceContentSurfaceAllowsCorpus(surface: ResourceContentSurface): boolean {
	return surface === 'app';
}

export function hasResourceContentAccess(input: {
	surface: ResourceContentSurface;
	hasViewer: boolean;
	scope: string;
	inViewerLibrary: boolean;
}): boolean {
	if (!input.hasViewer) return false;
	return input.inViewerLibrary || (input.scope === 'corpus' && resourceContentSurfaceAllowsCorpus(input.surface));
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

export const RESOURCE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const RESOURCE_TRANSLATION_SOURCES = ['original', 'machine', 'human'] as const;

export type ResourceTranslationSource = (typeof RESOURCE_TRANSLATION_SOURCES)[number];
