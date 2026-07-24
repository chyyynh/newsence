// OKF v0.1 export: one collection index and one Markdown file per resource.

import { CONTENT_RESOURCE_TYPES, type ContentResourceType, type ResourceCategory } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { usesV2ResourceRelations } from '@db/resource-relations-read-path';
import { isValidUuid, queryRows, resourceContentAccessSql, textArraySql, toIsoString } from '@db/sql';
import { sql } from 'drizzle-orm';

export type ExportCollectionOkfInput = {
	collectionId: string;
	primaryLocale?: string | null;
	userId?: string | null;
};

type CollectionRow = {
	id: string;
	name: string;
	description: string | null;
	user_id: string | null;
};

type ResourceRow = {
	id: string;
	type: ContentResourceType;
	lang: string | null;
	title: string | null;
	url: string | null;
	summary: string | null;
	content: string | null;
	published_date: Date | string | null;
	tags: string[] | null;
	keywords: string[] | null;
	category: ResourceCategory | null;
};

type OkfFile = { path: string; content: string };

const BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const INDEX_DESCRIPTION_MAX = 240;
const encoder = new TextEncoder();

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
				'Content-Disposition': attachmentDisposition(bundle.slug),
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
				sql`SELECT id, name, description, user_id
					 FROM collections
					 WHERE id = ${input.collectionId}
					   AND (visibility = 'public' OR (${input.viewerId}::text IS NOT NULL AND user_id = ${input.viewerId}))
				 LIMIT 1`,
			)
		)[0];
		if (!collection) throw new Error('Collection not found');

		const resources = await readCollectionResources(
			db,
			collection.id,
			collection.user_id,
			input.viewerId,
			input.primaryLocale,
			usesV2ResourceRelations(env),
		);
		const collectionSlug = slugify(collection.name);
		if (!collectionSlug) throw new Error(`Collection ${collection.id} has no valid slug`);
		return {
			slug: `${collectionSlug}-${collection.id.slice(0, 8)}`,
			files: renderOkfFiles(collection, resources),
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
	collectionOwnerId: string | null,
	viewerId: string | null,
	primaryLocale: string | null,
	useV2Relations: boolean,
): Promise<ResourceRow[]> {
	if (useV2Relations) {
		const canReadContent = resourceContentAccessSql('export', {
			viewerHasOwnership: sql`viewer_save.id IS NOT NULL OR viewer_file.id IS NOT NULL`,
			scope: sql`r.scope`,
		});
		return queryRows<ResourceRow>(
			db,
			sql`SELECT
			     r.id::text,
			     r.type,
			     localized.lang,
			     localized.title,
			     r.url,
			     localized.summary,
			     CASE WHEN ${canReadContent} THEN localized.content ELSE NULL END AS content,
			     COALESCE(r.published_date, r.scraped_date, r.created_at) AS published_date,
			     r.tags,
			     localized.keywords,
			     r.category
			   FROM collection_resources edge
			   JOIN collections collection
			     ON collection.id = edge.collection_id
			    AND collection.user_id = ${collectionOwnerId}
			   JOIN resources r ON r.id = edge.resource_id
			   LEFT JOIN resource_saves viewer_save
			     ON viewer_save.resource_id = r.id
			    AND viewer_save.user_id = ${viewerId}
			   LEFT JOIN user_files viewer_file
			     ON viewer_file.resource_id = r.id
			    AND viewer_file.user_id = ${viewerId}
			   LEFT JOIN LATERAL (
			     SELECT rl.lang, rl.title, rl.summary, rl.content, rl.keywords
			     FROM resources_localized rl
			     WHERE rl.id = r.id
			       AND rl.lang IN (r.original_lang, COALESCE(${primaryLocale}::text, r.original_lang))
			     ORDER BY CASE
			       WHEN rl.lang = COALESCE(${primaryLocale}::text, r.original_lang) THEN 0
			       ELSE 1
			     END
			     LIMIT 1
			   ) localized ON TRUE
			   WHERE edge.collection_id = ${collectionId}::uuid
			     AND r.type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
			     AND (
			       (r.scope = 'corpus' AND r.enrichment_status = 'enriched')
			       OR viewer_save.id IS NOT NULL
			       OR viewer_file.id IS NOT NULL
			     )
			   ORDER BY edge.added_at ASC, edge.resource_id ASC`,
		);
	}

	const canReadContent = resourceContentAccessSql('export', {
		viewerHasOwnership: sql`viewer_library.id IS NOT NULL`,
		scope: sql`r.scope`,
	});
	return queryRows<ResourceRow>(
		db,
		sql`SELECT
		     r.id::text,
		     r.type,
		     localized.lang,
		     localized.title,
		     r.url,
		     localized.summary,
		     CASE WHEN ${canReadContent} THEN localized.content ELSE NULL END AS content,
		     COALESCE(r.published_date, r.scraped_date, r.created_at) AS published_date,
		     r.tags,
		     localized.keywords,
		     r.category
		   FROM resource_links link
		   JOIN resources r ON link.to_type = 'resource' AND r.id = link.to_id
		   LEFT JOIN library viewer_library
		     ON viewer_library.resource_id = r.id
		    AND viewer_library.user_id = ${viewerId}
		   LEFT JOIN LATERAL (
		     SELECT rl.lang, rl.title, rl.summary, rl.content, rl.keywords
		     FROM resources_localized rl
		     WHERE rl.id = r.id
		       AND rl.lang IN (r.original_lang, COALESCE(${primaryLocale}::text, r.original_lang))
		     ORDER BY CASE
		       WHEN rl.lang = COALESCE(${primaryLocale}::text, r.original_lang) THEN 0
		       ELSE 1
		     END
		     LIMIT 1
		   ) localized ON TRUE
			   WHERE link.from_type = 'collection'
			     AND link.from_id = ${collectionId}::text
			     AND link.user_id = ${collectionOwnerId}
			     AND r.type = ANY(${textArraySql(CONTENT_RESOURCE_TYPES)})
			     AND (
			       (r.scope = 'corpus' AND r.enrichment_status = 'enriched')
			       OR viewer_library.id IS NOT NULL
			     )
		   ORDER BY link.created_at ASC, link.id ASC`,
	);
}

function* renderOkfFiles(collection: CollectionRow, resources: ResourceRow[]): Iterable<OkfFile> {
	const resourcePaths = assignResourcePaths(resources);
	yield { path: 'index.md', content: renderIndex(collection, resources, resourcePaths) };
	for (const resource of resources) {
		yield { path: resourcePaths.get(resource.id)!, content: renderResource(resource) };
	}
}

function renderIndex(collection: CollectionRow, resources: ResourceRow[], paths: Map<string, string>): string {
	return compactMarkdown([
		frontmatter({ okf_version: '0.1' }),
		`# ${collection.name}`,
		collection.description ?? '',
		'## Resources',
		...resources.map((resource) => {
			const summary = oneLine(resource.summary ?? '');
			const clipped = summary.length > INDEX_DESCRIPTION_MAX ? `${summary.slice(0, INDEX_DESCRIPTION_MAX)}...` : summary;
			return `* ${markdownLink(resourceLabel(resource), `/${paths.get(resource.id)!}`)}${clipped ? ` - ${clipped}` : ''}`;
		}),
	]);
}

function renderResource(resource: ResourceRow): string {
	return compactMarkdown([
		frontmatter({
			type: resource.type,
			title: resource.title,
			description: resource.summary,
			resource: resource.url,
			tags: resource.tags?.length ? resource.tags : undefined,
			timestamp: toIsoString(resource.published_date),
			language: resource.lang,
			keywords: resource.keywords?.length ? resource.keywords : undefined,
			category: resource.category,
		}),
		`# ${resourceLabel(resource)}`,
		resource.summary ?? '',
		resource.content ?? '',
		...(resource.url ? ['# Citations', `[1] ${markdownLink(resource.url, resource.url)}`] : []),
	]);
}

function resourceLabel(resource: ResourceRow): string {
	const title = resource.title?.trim();
	if (!title) throw new Error(`Resource ${resource.id} has no title`);
	return title;
}

function assignResourcePaths(resources: ResourceRow[]): Map<string, string> {
	const used = new Set<string>();
	const paths = new Map<string, string>();
	for (const resource of resources) {
		const base = slugify(resourceLabel(resource));
		if (!base) throw new Error(`Resource ${resource.id} has no valid slug`);
		let slug = base;
		for (let index = 2; used.has(slug); index++) slug = `${base}-${index}`;
		used.add(slug);
		paths.set(resource.id, `resources/${slug}.md`);
	}
	return paths;
}

function slugify(value: string): string {
	const normalized = value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '');
	return utf8Prefix(normalized, 72);
}

function utf8Prefix(value: string, maxBytes: number): string {
	let result = '';
	let byteLength = 0;
	for (const character of value) {
		const characterBytes = encoder.encode(character).byteLength;
		if (byteLength + characterBytes > maxBytes) break;
		result += character;
		byteLength += characterBytes;
	}
	return result;
}

function attachmentDisposition(slug: string): string {
	const filename = `${slug}.okf.tar.gz`;
	const fallback = filename.replace(/[^\x20-\x7e]+/g, '-').replace(/["\\]/g, '-');
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function markdownLink(label: string, target: string): string {
	const escapedLabel = oneLine(label).replace(/([\\[\]])/g, '\\$1');
	const escapedTarget = target.startsWith('/') ? target : `<${target.replace(/[\s<>]/g, (character) => encodeURIComponent(character))}>`;
	return `[${escapedLabel}](${escapedTarget})`;
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
	return `${parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join('\n\n')}\n`;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
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
	return tarStream.pipeThrough({
		readable: compression.readable as ReadableStream<Uint8Array>,
		writable: compression.writable as WritableStream<Uint8Array>,
	});
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
	if (bytes.byteLength > length) throw new Error(`Tar header field exceeds ${length} bytes`);
	header.set(bytes, offset);
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
	writeTarString(header, 148, 6, value.toString(8).padStart(6, '0').slice(0, 6));
	header[154] = 0;
	header[155] = 0x20;
}
