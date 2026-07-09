// OKF (Open Knowledge Format v0.1) collection export — issue #197 Phase 1.
// Streams a collection as a tar.gz bundle of markdown + YAML frontmatter:
// index.md (okf_version) / resources/*.md / entities/*.md / log.md.
// Entity links are read from resource_entities, which the ingest pipeline and
// #219 backfill normalize before storage.

import { type CoreDb, withCoreDb } from '@db/client';
import { type SQL, sql } from 'drizzle-orm';
import type { ResourceCategory, ResourceType } from './resources/types';

export type ExportCollectionOkfInput = {
	collectionId: string;
	primaryLocale?: string | null;
	userId?: string | null;
};

type OkfFile = { path: string; content: string };

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
	article_count: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const encoder = new TextEncoder();

export async function exportCollectionOkf(env: CoreEnv, input: ExportCollectionOkfInput): Promise<Response> {
	const collectionId = input.collectionId.trim();
	const primaryLocale = normalizePrimaryLocale(input.primaryLocale);
	const viewerId = input.userId?.trim() || null;
	if (!collectionId || !UUID_RE.test(collectionId)) {
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

async function queryRows<T>(db: CoreDb, statement: SQL): Promise<T[]> {
	return (await db.execute(statement)).rows as T[];
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
		       WHEN ${viewerId}::text IS NOT NULL
		         AND (c.user_id = ${viewerId} OR viewer_library.id IS NOT NULL)
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
		     COALESCE(other_translations.translations, '[]'::jsonb) AS translations
		   FROM citations c
		   JOIN resources r ON c.to_type = 'resource' AND r.id = c.to_id
		   LEFT JOIN library viewer_library
		     ON viewer_library.resource_id = r.id
		    AND viewer_library.user_id = ${viewerId}
		   LEFT JOIN LATERAL (
		     SELECT rt.lang, rt.title, rt.summary, rt.content, rt.keywords, rt.source
		     FROM resource_translations rt
		     WHERE rt.resource_id = r.id
		     ORDER BY
		       (${primaryLocale}::text IS NOT NULL AND rt.lang = ${primaryLocale}) DESC,
		       (rt.lang = r.original_lang) DESC,
		       (rt.source = 'original') DESC,
		       rt.lang ASC
		     LIMIT 1
		   ) primary_translation ON TRUE
		   LEFT JOIN LATERAL (
		     SELECT jsonb_agg(
		       jsonb_build_object(
		         'lang', rt.lang,
		         'title', rt.title,
		         'summary', rt.summary,
		         'content', CASE
		           WHEN ${viewerId}::text IS NOT NULL
		             AND (c.user_id = ${viewerId} OR viewer_library.id IS NOT NULL)
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
		       OR (
		         ${viewerId}::text IS NOT NULL
		         AND (c.user_id = ${viewerId} OR viewer_library.id IS NOT NULL)
		       )
		     )
		   ORDER BY c.created_at ASC`,
	);
	return rows.map((row) => ({ ...row, translations: normalizeTranslations(row.translations) }));
}

async function readResourceEntityLinks(db: CoreDb, resources: ResourceRow[]): Promise<EntityLinkRow[]> {
	return queryRows<EntityLinkRow>(
		db,
		sql`SELECT
		   re.resource_id::text, e.id::text, e.name, e.name_cn, e.type, e.article_count
		 FROM resource_entities re
		 JOIN entities e ON e.id = re.entity_id
		 WHERE re.resource_id = ANY(${resources.map((resource) => resource.id)}::uuid[])
		 ORDER BY e.article_count DESC, e.name ASC`,
	);
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
	// Bundle-absolute links throughout, matching article/entity pages.
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
			timestamp: toIso(resource.published_date),
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
			newsence_entity_id: entity.id,
			newsence_global_article_count: entity.article_count,
			newsence_bundle_resource_count: linkedResources.length,
		}),
		`# ${entity.name}`,
		entity.name_cn && entity.name_cn !== entity.name ? `Chinese name: ${entity.name_cn}` : '',
		'## Mentioned in',
		...resourceLinks,
	]);
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

function markdownLink(label: string, target: string): string {
	return `[${escapeMarkdownLinkText(oneLine(label))}](${escapeMarkdownLinkTarget(target)})`;
}

function escapeMarkdownLinkText(value: string): string {
	return value.replace(/([\\[\]])/g, '\\$1');
}

function escapeMarkdownLinkTarget(value: string): string {
	return value.startsWith('/') ? value : `<${value.replace(/[\s<>]/g, (ch) => encodeURIComponent(ch))}>`;
}

function frontmatter(fields: Record<string, unknown>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(fields)) {
		const yaml = yamlValue(value);
		if (yaml !== null) lines.push(`${key}: ${yaml}`);
	}
	lines.push('---');
	return lines.join('\n');
}

function yamlValue(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (Array.isArray(value)) {
		const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
		return items.length ? `[${items.map((item) => JSON.stringify(item)).join(', ')}]` : null;
	}
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

function compactMarkdown(parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join('\n\n')
		.concat('\n');
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function toIso(value: Date | string | null): string | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function assignPaths(items: Array<{ id: string; label: string }>, prefix: string): Map<string, string> {
	const used = new Set<string>();
	const paths = new Map<string, string>();
	for (const item of items) {
		const base = slugify(item.label) || slugify(item.id) || 'item';
		let slug = base;
		for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
		used.add(slug);
		paths.set(item.id, `${prefix}/${slug}.md`);
	}
	return paths;
}

function uniqueSlug(label: string, id: string): string {
	return `${slugify(label) || 'collection'}-${slugify(id) || 'item'}`;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 72);
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
	const map = new Map<K, T[]>();
	for (const item of items) {
		const k = key(item);
		const values = map.get(k) ?? [];
		values.push(item);
		map.set(k, values);
	}
	return map;
}

function uniqueBy<T, K>(items: T[], key: (item: T) => K): T[] {
	const seen = new Set<K>();
	return items.filter((item) => {
		const k = key(item);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

function tarGzipStream(files: Iterable<OkfFile>): ReadableStream<Uint8Array> {
	const iterator = files[Symbol.iterator]();
	let closed = false;
	const tarStream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (closed) return;
			const next = iterator.next();
			if (!next.done) {
				enqueueTarFile(controller, next.value);
				return;
			}
			closed = true;
			controller.enqueue(new Uint8Array(1024));
			controller.close();
		},
	});
	const compression = new CompressionStream('gzip');
	const gzip: ReadableWritablePair<Uint8Array, Uint8Array> = {
		readable: compression.readable as ReadableStream<Uint8Array>,
		writable: compression.writable as WritableStream<Uint8Array>,
	};
	return tarStream.pipeThrough(gzip);
}

function enqueueTarFile(controller: ReadableStreamDefaultController<Uint8Array>, file: OkfFile): void {
	const body = encoder.encode(file.content);
	controller.enqueue(tarHeader(file.path, body.byteLength));
	controller.enqueue(body);
	const remainder = body.byteLength % 512;
	if (remainder) controller.enqueue(new Uint8Array(512 - remainder));
}

function tarHeader(path: string, size: number): Uint8Array {
	const header = new Uint8Array(512);
	writeTarString(header, 0, 100, path);
	writeTarOctal(header, 100, 8, 0o644);
	writeTarOctal(header, 108, 8, 0);
	writeTarOctal(header, 116, 8, 0);
	writeTarOctal(header, 124, 12, size);
	writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
	header.fill(0x20, 148, 156);
	header[156] = '0'.charCodeAt(0);
	writeTarString(header, 257, 6, 'ustar');
	writeTarString(header, 263, 2, '00');
	let checksum = 0;
	for (const byte of header) checksum += byte;
	writeTarChecksum(header, checksum);
	return header;
}

function writeTarString(header: Uint8Array, offset: number, length: number, value: string): void {
	const bytes = encoder.encode(value);
	header.set(bytes.slice(0, length), offset);
}

function writeTarOctal(header: Uint8Array, offset: number, length: number, value: number): void {
	const octal = value
		.toString(8)
		.padStart(length - 1, '0')
		.slice(0, length - 1);
	writeTarString(header, offset, length, octal);
	header[offset + length - 1] = 0;
}

function writeTarChecksum(header: Uint8Array, value: number): void {
	const octal = value.toString(8).padStart(6, '0').slice(0, 6);
	writeTarString(header, 148, 6, octal);
	header[154] = 0;
	header[155] = 0x20;
}
