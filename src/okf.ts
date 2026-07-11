// OKF (Open Knowledge Format v0.1) collection export.
// Streams a collection as a tar.gz bundle of markdown + YAML frontmatter:
// index.md (okf_version) / resources/*.md / entities/*.md / log.md.
// Entity links are read from resource_entities, which the ingest pipeline and
// #219 backfill normalize before storage.

import type { ResourceCategory, ResourceType } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { isValidUuid, queryRows, toIsoString, uuidArraySql } from '@db/sql';
import { sql } from 'drizzle-orm';
import { type OkfFile, tarGzipStream } from './okf/archive';
import { assignPaths, compactMarkdown, frontmatter, groupBy, markdownLink, oneLine, uniqueBy, uniqueSlug } from './okf/markdown';
import { resourceContentAccessSql, resourceTranslationOrderSql } from './resource-query-policy';

export type ExportCollectionOkfInput = {
	collectionId: string;
	primaryLocale?: string | null;
	userId?: string | null;
};

type CollectionRow = {
	id: string;
	name: string;
	description: string | null;
	visibility: 'public' | 'private';
	updated_at: Date | string;
};

type ResourceRow = {
	id: string;
	type: ResourceType;
	original_lang: string;
	lang: string | null;
	title: string | null;
	url: string | null;
	summary: string | null;
	content: string | null;
	published_date: Date | string | null;
	tags: string[] | null;
	keywords: string[] | null;
	category: ResourceCategory | null;
	scope: 'corpus' | 'private';
	file_type: string | null;
	enrichment_status: 'pending' | 'enriched' | 'failed';
	translations: ResourceTranslationRow[];
};

type ResourceQueryRow = Omit<ResourceRow, 'translations'> & { translations: unknown };

type ResourceTranslationRow = {
	lang: string;
	title: string | null;
	summary: string | null;
	content: string | null;
	keywords: string[] | null;
	source: 'original' | 'machine' | 'human';
};

type EntityLinkRow = {
	resource_id: string;
	id: string;
	name: string;
	name_cn: string | null;
	type: string;
	resource_count: number;
	translations: EntityTranslationRow[];
};

type EntityLinkQueryRow = Omit<EntityLinkRow, 'name_cn' | 'translations'> & { translations: unknown };

type EntityTranslationRow = {
	lang: string;
	name: string;
	source: 'original' | 'machine' | 'human';
};

const BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export async function exportCollectionOkf(env: CoreEnv, input: ExportCollectionOkfInput): Promise<Response> {
	const collectionId = input.collectionId.trim();
	const primaryLocale = normalizePrimaryLocale(input.primaryLocale);
	const viewerId = input.userId?.trim() || null;
	if (!collectionId || !isValidUuid(collectionId)) {
		return Response.json({ code: 'BAD_REQUEST', message: 'Missing collectionId' }, { status: 400 });
	}
	if (primaryLocale === false) {
		return Response.json({ code: 'BAD_REQUEST', message: 'Invalid primaryLocale' }, { status: 400 });
	}

	try {
		const bundle = await buildCollectionOkfBundle(env, { viewerId, collectionId, primaryLocale });
		return new Response(tarGzipStream(bundle.files), {
			headers: {
				'Content-Type': 'application/gzip',
				'Content-Disposition': `attachment; filename="${bundle.slug}.okf.tar.gz"`,
				'Cache-Control': 'no-store',
			},
		});
	} catch (error) {
		if (error instanceof Error && error.message === 'Collection not found') {
			return Response.json({ code: 'NOT_FOUND', message: error.message }, { status: 404 });
		}
		console.error({ tag: 'OKF_EXPORT', msg: 'export failed', error: error instanceof Error ? error.message : String(error) });
		return Response.json({ code: 'INTERNAL_ERROR', message: 'OKF export failed' }, { status: 500 });
	}
}

async function buildCollectionOkfBundle(
	env: CoreEnv,
	input: { viewerId: string | null; collectionId: string; primaryLocale: string | null },
): Promise<{ slug: string; files: Iterable<OkfFile> }> {
	return withCoreDb(env, async (db) => {
		const collection = (
			await queryRows<CollectionRow>(
				db,
				sql`SELECT id, name, description, visibility, updated_at
					 FROM collections
					 WHERE id = ${input.collectionId}
					   AND (visibility = 'public' OR (${input.viewerId}::text IS NOT NULL AND user_id = ${input.viewerId}))
				 LIMIT 1`,
			)
		)[0];
		if (!collection) throw new Error('Collection not found');

		const resources = await readCollectionResources(db, collection.id, input.viewerId, input.primaryLocale);
		const links = resources.length ? await readResourceEntityLinks(db, resources) : [];
		return {
			slug: uniqueSlug(collection.name, collection.id),
			files: renderOkfFiles(collection, resources, links),
		};
	});
}

function normalizePrimaryLocale(value: string | null | undefined): string | null | false {
	const locale = value?.trim();
	if (!locale) return null;
	return BCP47_RE.test(locale) ? locale : false;
}

async function readCollectionResources(
	db: CoreDb,
	collectionId: string,
	viewerId: string | null,
	primaryLocale: string | null,
): Promise<ResourceRow[]> {
	const canReadContent = resourceContentAccessSql('export', {
		hasViewer: sql`${viewerId}::text IS NOT NULL`,
		inViewerLibrary: sql`viewer_library.id IS NOT NULL`,
		scope: sql`r.scope`,
	});
	const rows = await queryRows<ResourceQueryRow>(
		db,
		sql`SELECT
		     r.id::text,
		     r.type,
		     r.original_lang,
		     primary_translation.lang,
		     primary_translation.title,
		     r.url,
		     primary_translation.summary,
		     CASE
		       WHEN ${canReadContent}
		         THEN primary_translation.content
		       ELSE NULL
		     END AS content,
		     r.published_date,
		     r.tags,
		     primary_translation.keywords,
		     r.category,
		     r.scope,
		     r.file_type,
		     r.enrichment_status,
		     other_translations.translations AS translations
		   FROM resource_links c
		   JOIN resources r ON c.to_type = 'resource' AND r.id = c.to_id
		   LEFT JOIN library viewer_library
		     ON viewer_library.resource_id = r.id
		    AND viewer_library.user_id = ${viewerId}
		   LEFT JOIN LATERAL (
		     SELECT
		       rl.lang,
		       rl.title,
		       rl.summary,
		       rl.content,
		       rl.keywords,
		       rl.translation_source AS source
		     FROM resources_localized rl
		     WHERE rl.id = r.id
		     ORDER BY ${resourceTranslationOrderSql({
						lang: sql`rl.lang`,
						originalLang: sql`r.original_lang`,
						requestedLocale: sql`${primaryLocale}::text`,
					})}
		     LIMIT 1
		   ) primary_translation ON TRUE
		   LEFT JOIN LATERAL (
		     SELECT jsonb_agg(
		       jsonb_build_object(
		         'lang', rt.lang,
		         'title', rt.title,
		         'summary', rt.summary,
		         'content', CASE
		           WHEN ${canReadContent}
		             THEN rt.content
		           ELSE NULL
		         END,
		         'keywords', rt.keywords,
		         'source', rt.source
		       )
		       ORDER BY rt.lang
		     ) AS translations
		     FROM resource_translations rt
		     WHERE rt.resource_id = r.id
		       AND (primary_translation.lang IS NULL OR rt.lang <> primary_translation.lang)
		   ) other_translations ON TRUE
		   WHERE c.from_type = 'collection'
		     AND c.from_id = ${collectionId}::text
		     AND (
		       r.scope = 'corpus'
		       OR viewer_library.id IS NOT NULL
		     )
		   ORDER BY c.created_at ASC`,
	);
	return rows.map((row) => ({ ...row, translations: normalizeTranslations(row.translations) }));
}

async function readResourceEntityLinks(db: CoreDb, resources: ResourceRow[]): Promise<EntityLinkRow[]> {
	const resourceIdArray = uuidArraySql(resources.map((resource) => resource.id));
	const rows = await queryRows<EntityLinkQueryRow>(
		db,
		sql`SELECT
		   re.resource_id::text,
		   e.id::text,
		   e.name,
		   e.type,
		   e.resource_count,
		   jsonb_agg(
		     jsonb_build_object(
		       'lang', et.lang,
		       'name', et.name,
		       'source', et.source
		     )
		     ORDER BY et.lang
		   ) FILTER (WHERE et.entity_id IS NOT NULL) AS translations
		 FROM resource_entities re
		 JOIN entities e ON e.id = re.entity_id
		 LEFT JOIN entity_translations et ON et.entity_id = e.id
			 WHERE re.resource_id = ANY(${resourceIdArray})
		 GROUP BY re.resource_id, e.id
		 ORDER BY e.resource_count DESC, e.name ASC`,
	);
	return rows.map((row) => {
		const translations = normalizeEntityTranslations(row.translations);
		return {
			...row,
			name_cn: translations.find((translation) => translation.lang === 'zh-Hant')?.name ?? null,
			translations,
		};
	});
}

function* renderOkfFiles(collection: CollectionRow, resources: ResourceRow[], links: EntityLinkRow[]): Iterable<OkfFile> {
	const resourcePaths = assignPaths(
		resources.map((resource) => ({ id: resource.id, label: resourceLabel(resource) })),
		'resources',
	);
	const entityById = new Map<string, EntityLinkRow>();
	for (const link of links) if (!entityById.has(link.id)) entityById.set(link.id, link);
	const entityPaths = assignPaths(
		[...entityById.values()].map((entity) => ({ id: entity.id, label: entity.name })),
		'entities',
	);
	const linksByResourceId = groupBy(links, (link) => link.resource_id);
	const linksByEntityId = groupBy(links, (link) => link.id);

	yield { path: 'index.md', content: renderRootIndex(collection, resources, entityById, resourcePaths, entityPaths) };
	yield {
		path: 'resources/index.md',
		content: compactMarkdown([
			'# Resources',
			...resources.map((resource) =>
				indexEntry(resourceLabel(resource), resourcePaths.get(resource.id)!.slice('resources/'.length), resource.summary),
			),
		]),
	};
	if (entityById.size > 0) {
		yield {
			path: 'entities/index.md',
			content: compactMarkdown([
				'# Entities',
				...[...entityById.values()].map((entity) =>
					indexEntry(entity.name, entityPaths.get(entity.id)!.slice('entities/'.length), entity.name_cn),
				),
			]),
		};
	}
	for (const resource of resources) {
		yield {
			path: resourcePaths.get(resource.id)!,
			content: renderResource(resource, linksByResourceId.get(resource.id) ?? [], entityPaths),
		};
	}
	for (const entity of entityById.values()) {
		yield {
			path: entityPaths.get(entity.id)!,
			content: renderEntity(entity, linksByEntityId.get(entity.id) ?? [], resources, resourcePaths),
		};
	}
	yield { path: 'log.md', content: renderLog(collection, resources.length, entityById.size) };
}

function renderRootIndex(
	collection: CollectionRow,
	resources: ResourceRow[],
	entityById: Map<string, EntityLinkRow>,
	resourcePaths: Map<string, string>,
	entityPaths: Map<string, string>,
): string {
	// Bundle-absolute links throughout, matching resource/entity pages.
	const lines = [
		frontmatter({ okf_version: '0.1' }),
		`# ${collection.name}`,
		collection.description ?? '',
		'## Resources',
		...resources.map((resource) => indexEntry(resourceLabel(resource), `/${resourcePaths.get(resource.id)!}`, resource.summary)),
	];
	if (entityById.size > 0) {
		lines.push(
			'## Entities',
			...[...entityById.values()].map((entity) => indexEntry(entity.name, `/${entityPaths.get(entity.id)!}`, entity.name_cn)),
		);
	}
	return compactMarkdown(lines);
}

function resourceLabel(resource: ResourceRow): string {
	return resource.title || resource.url || resource.id;
}

function renderResource(resource: ResourceRow, links: EntityLinkRow[], entityPaths: Map<string, string>): string {
	const content = resource.content ?? '';
	const entityLinks = uniqueBy(links, (link) => link.id).map((link) => `- ${markdownLink(link.name, `/${entityPaths.get(link.id)}`)}`);
	const citation = resource.url ? ['# Citations', `[1] ${markdownLink(resource.url, resource.url)}`] : [];
	return compactMarkdown([
		frontmatter({
			type: resource.type,
			title: resource.title,
			description: resource.summary,
			resource: resource.url,
			tags: resource.tags?.length ? resource.tags : undefined,
			timestamp: toIsoString(resource.published_date),
			// extension keys (spec §frontmatter: consumers must tolerate unknown keys)
			keywords: resource.keywords?.length ? resource.keywords : undefined,
			category: resource.category,
			original_lang: resource.original_lang,
			...translationExtensionFields(resource.translations),
			scope: resource.scope,
			file_type: resource.file_type,
			enrichment_status: resource.enrichment_status,
			newsence_resource_id: resource.id,
		}),
		`# ${resourceLabel(resource)}`,
		resource.summary ?? '',
		entityLinks.length ? '## Linked entities' : '',
		...entityLinks,
		content,
		...citation,
	]);
}

function translationExtensionFields(translations: ResourceTranslationRow[]): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const translation of translations) {
		const suffix = translation.lang;
		fields[`title_${suffix}`] = translation.title;
		fields[`description_${suffix}`] = translation.summary;
		fields[`keywords_${suffix}`] = translation.keywords?.length ? translation.keywords : undefined;
		fields[`content_${suffix}`] = translation.content;
	}
	return fields;
}

function renderEntity(entity: EntityLinkRow, links: EntityLinkRow[], resources: ResourceRow[], resourcePaths: Map<string, string>): string {
	const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
	const linkedResources = uniqueBy(links, (link) => link.resource_id)
		.map((link) => resourceById.get(link.resource_id))
		.filter((resource): resource is ResourceRow => !!resource);
	const resourceLinks = linkedResources.map(
		(resource) => `- ${markdownLink(resourceLabel(resource), `/${resourcePaths.get(resource.id)}`)}`,
	);
	return compactMarkdown([
		frontmatter({
			type: entity.type,
			title: entity.name,
			// extension keys
			name_cn: entity.name_cn,
			...entityTranslationExtensionFields(entity),
			newsence_entity_id: entity.id,
			newsence_global_resource_count: entity.resource_count,
			newsence_bundle_resource_count: linkedResources.length,
		}),
		`# ${entity.name}`,
		entity.name_cn && entity.name_cn !== entity.name ? `Chinese name: ${entity.name_cn}` : '',
		'## Mentioned in',
		...resourceLinks,
	]);
}

function entityTranslationExtensionFields(entity: EntityLinkRow): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const translation of entity.translations) {
		if (translation.name === entity.name) continue;
		fields[`title_${translation.lang}`] = translation.name;
	}
	return fields;
}

function normalizeTranslations(value: unknown): ResourceTranslationRow[] {
	const raw = typeof value === 'string' ? safeJsonParse(value) : value;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const lang = typeof row.lang === 'string' && row.lang.trim() ? row.lang.trim() : null;
		if (!lang) return [];
		const source = row.source === 'machine' || row.source === 'human' || row.source === 'original' ? row.source : 'machine';
		return [
			{
				lang,
				title: nullableStringValue(row.title),
				summary: nullableStringValue(row.summary),
				content: nullableStringValue(row.content),
				keywords: stringArrayValue(row.keywords),
				source,
			},
		];
	});
}

function normalizeEntityTranslations(value: unknown): EntityTranslationRow[] {
	const raw = typeof value === 'string' ? safeJsonParse(value) : value;
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
		const row = item as Record<string, unknown>;
		const lang = typeof row.lang === 'string' && row.lang.trim() ? row.lang.trim() : null;
		const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null;
		const source = row.source === 'machine' || row.source === 'human' ? row.source : 'original';
		return lang && name && BCP47_RE.test(lang) ? [{ lang, name, source }] : [];
	});
}

function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function nullableStringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

function stringArrayValue(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
	return items.length ? items : null;
}

function renderLog(collection: CollectionRow, resourceCount: number, entityCount: number): string {
	const exportedAt = new Date().toISOString();
	return compactMarkdown([
		'# Directory Update Log',
		`## ${exportedAt.slice(0, 10)}`,
		`* **Export**: OKF bundle for "${collection.name}" — ${resourceCount} resources, ${entityCount} entity pages.`,
		`* **Collection id**: ${collection.id} (visibility: ${collection.visibility}). Exported at ${exportedAt}.`,
		'* **Entity links**: exported from stored `resource_entities` links.',
		'* **Producer notes**: non-primary locale fields use BCP-47 suffixes like `title_zh-Hant`; `keywords` and `category` are extension frontmatter keys.',
	]);
}

const INDEX_DESCRIPTION_MAX = 240;

function indexEntry(title: string, path: string, description: string | null | undefined): string {
	const summary = description ? oneLine(description) : '';
	const clipped = summary.length > INDEX_DESCRIPTION_MAX ? `${summary.slice(0, INDEX_DESCRIPTION_MAX)}…` : summary;
	return `* ${markdownLink(title, path)}${clipped ? ` - ${clipped}` : ''}`;
}
