import { canonicalizeOptionalResourceLang } from './resource-types';

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
