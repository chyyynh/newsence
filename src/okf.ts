// ─────────────────────────────────────────────────────────────
// OKF (Open Knowledge Format v0.1) collection export — issue #197 Phase 1.
// Streams a collection as a tar.gz bundle of markdown + YAML frontmatter:
// index.md (okf_version) / articles/*.md / entities/*.md / log.md.
// Entity links are read from article_entities, which the ingest pipeline already
// normalizes before storage.
// ─────────────────────────────────────────────────────────────

import { Client } from 'pg';

export type ExportCollectionOkfInput = {
	collectionId: string;
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

type ArticleRow = {
	id: string;
	kind: 'article' | 'user_file';
	title: string;
	title_cn: string | null;
	url: string;
	source: string | null;
	source_type: string | null;
	summary: string | null;
	summary_cn: string | null;
	content: string | null;
	content_cn: string | null;
	published_date: Date | string | null;
	tags: string[] | null;
	keywords: string[] | null;
	platform_metadata: unknown;
};

type EntityLinkRow = {
	article_id: string;
	id: string;
	name: string;
	name_cn: string | null;
	type: string;
	article_count: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTICLE_CATEGORY_TAGS = new Set(['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other']);
const encoder = new TextEncoder();

export async function exportCollectionOkf(env: CoreEnv, input: ExportCollectionOkfInput): Promise<Response> {
	const collectionId = input.collectionId.trim();
	const viewerId = input.userId?.trim() || null;
	if (!collectionId || !UUID_RE.test(collectionId)) {
		return Response.json({ code: 'BAD_REQUEST', message: 'Missing collectionId' }, { status: 400 });
	}

	try {
		const bundle = await buildCollectionOkfBundle(env, { viewerId, collectionId });
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
	input: { viewerId: string | null; collectionId: string },
): Promise<{ slug: string; files: Iterable<OkfFile> }> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const collection = (
		await db.query<CollectionRow>(
			`SELECT id, name, description, visibility, updated_at
						 FROM collections
						 WHERE id = $1
						   AND (visibility = 'public' OR ($2::text IS NOT NULL AND user_id = $2))
				 LIMIT 1`,
			[input.collectionId, input.viewerId],
		)
	).rows[0];
	if (!collection) throw new Error('Collection not found');

	const articles = await readCollectionArticles(db, collection.id, input.viewerId);
	const linkableArticles = articles.filter((article) => article.kind === 'article');
	const links = linkableArticles.length ? await readArticleEntityLinks(db, linkableArticles) : [];
	return {
		slug: uniqueSlug(collection.name, collection.id),
		files: renderOkfFiles(collection, articles, links),
	};
}

async function readCollectionArticles(db: Client, collectionId: string, viewerId: string | null): Promise<ArticleRow[]> {
	const result = await db.query<ArticleRow>(
		`SELECT *
		 FROM (
		   SELECT
		     c.created_at,
		     'article'::text AS kind,
		     a.id::text, a.title, a.title_cn, a.url, a.source, a.source_type,
		     a.summary, a.summary_cn, a.content, a.content_cn, a.published_date,
		     a.tags, a.keywords, a.platform_metadata
		   FROM citations c
		   JOIN articles a ON c.to_type = 'article' AND a.id = c.to_id
		   WHERE c.from_type = 'collection'
		     AND c.from_id = $1::text
		   UNION ALL
		   SELECT
		     c.created_at,
		     'user_file'::text AS kind,
		     uf.id::text,
		     COALESCE(uf.title, uf.file_name) AS title,
		     uf.title_cn,
		     COALESCE(uf.source_url, '') AS url,
		     COALESCE(uf.site_name, uf.source_url, uf.file_type) AS source,
		     COALESCE(uf.platform_type, uf.origin_type) AS source_type,
		     uf.summary,
		     uf.summary_cn,
		     uf.extracted_text AS content,
		     uf.content_cn,
		     COALESCE(uf.published_date, uf.created_at) AS published_date,
		     uf.tags,
		     uf.keywords,
		     uf.metadata AS platform_metadata
		   FROM citations c
		   JOIN user_files uf ON c.to_type = 'user_file'
		     AND uf.id = c.to_id
		     AND uf.user_id = $2
		   WHERE c.from_type = 'collection'
		     AND c.from_id = $1::text
		 ) resources
		 ORDER BY created_at ASC`,
		[collectionId, viewerId],
	);
	return result.rows;
}

async function readArticleEntityLinks(db: Client, articles: ArticleRow[]): Promise<EntityLinkRow[]> {
	const result = await db.query<EntityLinkRow>(
		`SELECT
		   ae.article_id::text, e.id::text, e.name, e.name_cn, e.type, e.article_count
		 FROM article_entities ae
		 JOIN entities e ON e.id = ae.entity_id
		 WHERE ae.article_id = ANY($1::uuid[])
		 ORDER BY e.article_count DESC, e.name ASC`,
		[articles.map((article) => article.id)],
	);
	return result.rows;
}

function* renderOkfFiles(collection: CollectionRow, articles: ArticleRow[], links: EntityLinkRow[]): Iterable<OkfFile> {
	const articlePaths = assignPaths(
		articles.map((article) => ({ id: resourceKey(article), label: article.title || article.title_cn || article.id })),
		'articles',
	);
	const entityById = new Map<string, EntityLinkRow>();
	for (const link of links) if (!entityById.has(link.id)) entityById.set(link.id, link);
	const entityPaths = assignPaths(
		[...entityById.values()].map((entity) => ({ id: entity.id, label: entity.name })),
		'entities',
	);
	const linksByArticleId = groupBy(links, (link) => link.article_id);
	const linksByEntityId = groupBy(links, (link) => link.id);

	yield { path: 'index.md', content: renderRootIndex(collection, articles, entityById, articlePaths, entityPaths) };
	yield {
		path: 'articles/index.md',
		content: compactMarkdown([
			'# Resources',
			...articles.map((article) =>
				indexEntry(displayTitle(article), articlePaths.get(resourceKey(article))!.slice('articles/'.length), displayDescription(article)),
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
	for (const article of articles) {
		yield {
			path: articlePaths.get(resourceKey(article))!,
			content: renderArticle(article, linksByArticleId.get(article.id) ?? [], entityPaths),
		};
	}
	for (const entity of entityById.values()) {
		yield {
			path: entityPaths.get(entity.id)!,
			content: renderEntity(entity, linksByEntityId.get(entity.id) ?? [], articles, articlePaths),
		};
	}
	yield { path: 'log.md', content: renderLog(collection, articles.length, entityById.size) };
}

function renderRootIndex(
	collection: CollectionRow,
	articles: ArticleRow[],
	entityById: Map<string, EntityLinkRow>,
	articlePaths: Map<string, string>,
	entityPaths: Map<string, string>,
): string {
	// Bundle-absolute links throughout, matching article/entity pages.
	const lines = [
		frontmatter({ okf_version: '0.1' }),
		`# ${collection.name}`,
		collection.description ?? '',
		'## Resources',
		...articles.map((article) =>
			indexEntry(displayTitle(article), `/${articlePaths.get(resourceKey(article))!}`, displayDescription(article)),
		),
	];
	if (entityById.size > 0) {
		lines.push(
			'## Entities',
			...[...entityById.values()].map((entity) => indexEntry(entity.name, `/${entityPaths.get(entity.id)!}`, entity.name_cn)),
		);
	}
	return compactMarkdown(lines);
}

function resourceKey(article: ArticleRow): string {
	return `${article.kind}:${article.id}`;
}

function renderArticle(article: ArticleRow, links: EntityLinkRow[], entityPaths: Map<string, string>): string {
	const title = displayTitle(article);
	const summary = displayDescription(article);
	const content = article.content || article.content_cn || summary || '';
	const entityLinks = uniqueBy(links, (link) => link.id).map((link) => `- ${markdownLink(link.name, `/${entityPaths.get(link.id)}`)}`);
	const citation = article.url ? [`# Citations`, `[1] ${markdownLink(article.source || article.url, article.url)}`] : [];
	return compactMarkdown([
		frontmatter({
			type: article.kind === 'user_file' ? 'UserFile' : 'Article',
			title,
			description: summary,
			resource: article.url || undefined,
			tags: article.tags?.length ? article.tags : undefined,
			timestamp: toIso(article.published_date),
			// extension keys (spec §frontmatter: consumers must tolerate unknown keys)
			keywords: article.keywords?.length ? article.keywords : undefined,
			category: articleCategory(article),
			source: article.source,
			source_type: article.source_type,
			title_cn: article.title_cn,
			description_cn: article.summary_cn,
			newsence_resource_id: article.id,
			newsence_resource_type: article.kind,
			newsence_article_id: article.kind === 'article' ? article.id : undefined,
		}),
		`# ${title}`,
		summary ?? '',
		entityLinks.length ? '## Linked entities' : '',
		...entityLinks,
		content,
		...citation,
	]);
}

function displayTitle(article: ArticleRow): string {
	return article.title || article.title_cn || 'Untitled article';
}

function displayDescription(article: ArticleRow): string | null {
	return article.summary || article.summary_cn;
}

function renderEntity(entity: EntityLinkRow, links: EntityLinkRow[], articles: ArticleRow[], articlePaths: Map<string, string>): string {
	const articleById = new Map(articles.map((article) => [article.id, article]));
	const linkedArticles = uniqueBy(links, (link) => link.article_id)
		.map((link) => articleById.get(link.article_id))
		.filter((article): article is ArticleRow => !!article);
	const articleLinks = linkedArticles.map(
		(article) => `- ${markdownLink(displayTitle(article), `/${articlePaths.get(resourceKey(article))}`)}`,
	);
	return compactMarkdown([
		frontmatter({
			type: entity.type,
			title: entity.name,
			// extension keys
			name_cn: entity.name_cn,
			newsence_entity_id: entity.id,
			newsence_global_article_count: entity.article_count,
			newsence_bundle_article_count: linkedArticles.length,
		}),
		`# ${entity.name}`,
		entity.name_cn && entity.name_cn !== entity.name ? `Chinese name: ${entity.name_cn}` : '',
		'## Mentioned in',
		...articleLinks,
	]);
}

function renderLog(collection: CollectionRow, resourceCount: number, entityCount: number): string {
	const exportedAt = new Date().toISOString();
	return compactMarkdown([
		'# Directory Update Log',
		`## ${exportedAt.slice(0, 10)}`,
		`* **Export**: OKF bundle for "${collection.name}" — ${resourceCount} resources, ${entityCount} entity pages.`,
		`* **Collection id**: ${collection.id} (visibility: ${collection.visibility}). Exported at ${exportedAt}.`,
		'* **Entity links**: exported from stored `article_entities` links.',
		'* **Producer notes**: bilingual fields (`title_cn`, `description_cn`, `name_cn`) and `keywords`/`category`/`source` are extension frontmatter keys. `category` prefers the stored classification, falling back to the known category tag.',
	]);
}

function articleCategory(article: ArticleRow): string | null {
	const metadata = article.platform_metadata as { classification?: { category?: string } } | null;
	const classified = metadata?.classification?.category;
	if (classified && ARTICLE_CATEGORY_TAGS.has(classified)) return classified;
	return article.tags?.find((tag) => ARTICLE_CATEGORY_TAGS.has(tag)) ?? null;
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
