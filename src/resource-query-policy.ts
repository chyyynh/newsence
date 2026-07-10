import { type ResourceContentSurface, resourceContentSurfaceAllowsCorpus } from '@core-shared/resource-content-access';
import { RESOURCE_LOCALE_FALLBACKS } from '@core-shared/resource-localization';
import { type SQL, sql } from 'drizzle-orm';

export function resourceContentAccessSql(
	surface: ResourceContentSurface,
	input: { hasViewer: SQL; inViewerLibrary: SQL; scope: SQL },
): SQL {
	return resourceContentSurfaceAllowsCorpus(surface)
		? sql`(${input.hasViewer} AND (${input.inViewerLibrary} OR ${input.scope} = 'corpus'))`
		: sql`(${input.hasViewer} AND ${input.inViewerLibrary})`;
}

export function resourceTranslationOrderSql(input: { lang: SQL; originalLang: SQL; requestedLocale?: SQL }): SQL {
	const requestedLocale = input.requestedLocale ?? sql`NULL::text`;
	const [defaultLocale, zhHantLocale] = RESOURCE_LOCALE_FALLBACKS;
	return sql`
		CASE
			WHEN ${requestedLocale} IS NOT NULL AND ${input.lang} = ${requestedLocale} THEN 0
			WHEN ${input.lang} = ${input.originalLang} THEN 1
			WHEN ${input.lang} = ${defaultLocale} THEN 2
			WHEN ${input.lang} = ${zhHantLocale} THEN 3
			ELSE 4
		END,
		${input.lang} ASC
	`;
}
