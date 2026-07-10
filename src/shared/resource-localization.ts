import { canonicalizeOptionalResourceLang, DEFAULT_RESOURCE_LANG, ZH_HANT_RESOURCE_LANG } from './resource-types';

export const RESOURCE_LOCALE_FALLBACKS = [DEFAULT_RESOURCE_LANG, ZH_HANT_RESOURCE_LANG] as const;

// requested -> per-resource original -> product defaults -> stable remainder
export function resourceLocalePreferenceOrder(
	requestedLocale: string | null | undefined,
	originalLang: string | null | undefined,
	availableLocales: readonly string[] = [],
): string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();
	const add = (value: string | null | undefined) => {
		const locale = canonicalizeOptionalResourceLang(value);
		if (!locale || seen.has(locale)) return;
		seen.add(locale);
		ordered.push(locale);
	};

	add(requestedLocale);
	add(originalLang);
	for (const locale of RESOURCE_LOCALE_FALLBACKS) add(locale);
	for (const locale of [...availableLocales].sort((a, b) => a.localeCompare(b))) add(locale);
	return ordered;
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
	for (const locale of resourceLocalePreferenceOrder(requestedLocale, originalLang, [...byLocale.keys()])) {
		const translation = byLocale.get(locale);
		if (translation) return translation;
	}
	return null;
}
