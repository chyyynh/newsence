import { jsonError, parseJsonBody, requireAuth } from '@shared/auth';
import { type DbClient, withDbClient } from '@shared/db';
import type { Env } from '@shared/types';

type OkfFile = { path: string; content: string };

type CollectionRow = {
	id: string;
	name: string;
	description: string | null;
	updated_at: Date | string;
};

type ArticleRow = {
	id: string;
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
	entities: unknown;
};

type EntityRow = {
	article_id: string;
	id: string;
	canonical_name: string;
	name: string;
	name_cn: string | null;
	type: string;
	article_count: number;
};

type EntityQualityStats = {
	totalLinks: number;
	exportedLinks: number;
	filteredGeneric: number;
	filteredSelfSource: number;
	filteredTooShort: number;
	jsonWithoutLinksArticles: number;
	articlesWithoutEntityLinks: number;
	unknownTypes: Record<string, number>;
};

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token, Authorization',
	'Access-Control-Expose-Headers': 'Content-Disposition',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASCII_GENERIC_ENTITY = new Set(['ai', 'x', 'go', 'us', 'c', 'v4', 'rl', 'pi']);
const OKF_ENTITY_TYPES = new Set(['person', 'organization', 'product', 'technology', 'event']);
const encoder = new TextEncoder();

export async function handleExportCollectionOkf(request: Request, env: Env): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

	const unauth = await requireAuth(request, env, CORS_HEADERS);
	if (unauth) return unauth;

	const body = await parseJsonBody<{ userId?: string; collectionId?: string }>(request, CORS_HEADERS);
	if (body instanceof Response) return body;
	if (!body.userId?.trim() || !body.collectionId?.trim() || !UUID_RE.test(body.collectionId)) {
		return jsonError('BAD_REQUEST', 'Missing userId or collectionId', 400, CORS_HEADERS);
	}

	try {
		const bundle = await buildCollectionOkfBundle(env, {
			userId: body.userId,
			collectionId: body.collectionId,
		});
		return new Response(tarGzipStream(bundle.files), {
			headers: {
				...CORS_HEADERS,
				'Content-Type': 'application/gzip',
				'Content-Disposition': `attachment; filename="${bundle.slug}.okf.tar.gz"`,
				'Cache-Control': 'no-store',
			},
		});
	} catch (error) {
		if (error instanceof Error && error.message === 'Collection not found') {
			return jsonError('NOT_FOUND', error.message, 404, CORS_HEADERS);
		}
		console.error({ tag: 'OKF_EXPORT', msg: 'export failed', error: error instanceof Error ? error.message : String(error) });
		return jsonError('INTERNAL_ERROR', 'OKF export failed', 500, CORS_HEADERS);
	}
}

async function buildCollectionOkfBundle(
	env: Env,
	input: { userId: string; collectionId: string },
): Promise<{ slug: string; files: OkfFile[] }> {
	return withDbClient(env, async (db) => {
		const collection = (
			await db.query<CollectionRow>(
				`SELECT id, name, description, updated_at
				 FROM collections
				 WHERE id = $1 AND user_id = $2
				 LIMIT 1`,
				[input.collectionId, input.userId],
			)
		).rows[0];
		if (!collection) throw new Error('Collection not found');

		const articles = await readCollectionArticles(db, collection.id, input.userId);
		const rawEntities = articles.length ? await readArticleEntities(db, articles) : [];
		const { entities, quality } = filterEntitiesForOkf(rawEntities, articles);
		return {
			slug: uniqueSlug(collection.name, collection.id),
			files: renderOkfFiles(collection, articles, entities, quality),
		};
	});
}

async function readCollectionArticles(db: DbClient, collectionId: string, userId: string): Promise<ArticleRow[]> {
	const result = await db.query<ArticleRow>(
		`SELECT
		   a.id::text,
		   a.title,
		   a.title_cn,
		   a.url,
		   a.source,
		   a.source_type,
		   a.summary,
		   a.summary_cn,
		   a.content,
		   a.content_cn,
		   a.published_date,
		   a.tags,
		   a.keywords,
		   a.entities
		 FROM citations c
		 JOIN articles a ON a.id::text = c.to_id
		 WHERE c.user_id = $1
		   AND c.from_type = 'collection'
		   AND c.from_id = $2
		   AND c.to_type = 'article'
		 ORDER BY c.created_at ASC`,
		[userId, collectionId],
	);
	return result.rows;
}

async function readArticleEntities(db: DbClient, articles: ArticleRow[]): Promise<EntityRow[]> {
	const articleIds = articles.map((article) => article.id);
	const result = await db.query<EntityRow>(
		`SELECT
		   ae.article_id::text,
		   e.id::text,
		   e.canonical_name,
		   e.name,
		   e.name_cn,
		   e.type,
		   e.article_count
		 FROM article_entities ae
		 JOIN entities e ON e.id = ae.entity_id
		 WHERE ae.article_id = ANY($1::uuid[])
		 ORDER BY e.article_count DESC, e.name ASC`,
		[articleIds],
	);
	return result.rows;
}

function filterEntitiesForOkf(entities: EntityRow[], articles: ArticleRow[]): { entities: EntityRow[]; quality: EntityQualityStats } {
	const articleById = new Map(articles.map((article) => [article.id, article]));
	const linkedArticleIds = new Set(entities.map((entity) => entity.article_id));
	const quality: EntityQualityStats = {
		totalLinks: entities.length,
		exportedLinks: 0,
		filteredGeneric: 0,
		filteredSelfSource: 0,
		filteredTooShort: 0,
		jsonWithoutLinksArticles: articles.filter((article) => hasJsonEntities(article.entities) && !linkedArticleIds.has(article.id)).length,
		articlesWithoutEntityLinks: articles.filter((article) => !linkedArticleIds.has(article.id)).length,
		unknownTypes: {},
	};
	const filtered = entities.filter((entity) => {
		const decision = entityFilterReason(entity, articleById.get(entity.article_id));
		if (decision === null) {
			quality.exportedLinks += 1;
			if (!OKF_ENTITY_TYPES.has(entity.type)) quality.unknownTypes[entity.type] = (quality.unknownTypes[entity.type] ?? 0) + 1;
			return true;
		}
		quality[decision] += 1;
		return false;
	});
	return { entities: filtered, quality };
}

function entityFilterReason(
	entity: EntityRow,
	article: ArticleRow | undefined,
): keyof Pick<EntityQualityStats, 'filteredGeneric' | 'filteredSelfSource' | 'filteredTooShort'> | null {
	const canonical = entity.canonical_name.trim().toLowerCase();
	if (!canonical || /^[a-z0-9]{1,2}$/i.test(canonical)) return 'filteredTooShort';
	if (ASCII_GENERIC_ENTITY.has(canonical)) return 'filteredGeneric';
	if (article?.source?.trim().toLowerCase() === canonical) return 'filteredSelfSource';
	return null;
}

function hasJsonEntities(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

function renderOkfFiles(collection: CollectionRow, articles: ArticleRow[], entities: EntityRow[], quality: EntityQualityStats): OkfFile[] {
	const articlePaths = assignPaths(
		articles.map((article) => ({ id: article.id, label: article.title_cn || article.title })),
		'articles',
	);
	const entityById = new Map<string, EntityRow>();
	for (const entity of entities) entityById.set(entity.id, entity);
	const entityPaths = assignPaths(
		[...entityById.values()].map((entity) => ({ id: entity.id, label: entity.name })),
		'entities',
	);
	const entitiesByArticleId = groupBy(entities, (entity) => entity.article_id);
	const articlesByEntityId = groupBy(entities, (entity) => entity.id);

	const files: OkfFile[] = [
		{
			path: 'index.md',
			content: renderRootIndex(collection, articles, entityById, articlePaths, entityPaths),
		},
		{
			path: 'articles/index.md',
			content: renderDirectoryIndex(
				'Articles',
				articles.map((article) =>
					indexEntry(
						article.title_cn || article.title,
						stripDirectoryPrefix(articlePaths.get(article.id)!, 'articles'),
						article.summary_cn || article.summary,
					),
				),
			),
		},
	];
	if (entityById.size > 0) {
		files.push({
			path: 'entities/index.md',
			content: renderDirectoryIndex(
				'Entities',
				[...entityById.values()].map((entity) =>
					indexEntry(entity.name, stripDirectoryPrefix(entityPaths.get(entity.id)!, 'entities'), entity.name_cn),
				),
			),
		});
	}
	for (const article of articles) {
		files.push({
			path: articlePaths.get(article.id)!,
			content: renderArticle(article, entitiesByArticleId.get(article.id) ?? [], entityPaths),
		});
	}
	for (const entity of entityById.values()) {
		files.push({
			path: entityPaths.get(entity.id)!,
			content: renderEntity(entity, articlesByEntityId.get(entity.id) ?? [], articles, articlePaths),
		});
	}
	files.push({ path: 'log.md', content: renderLog(collection, articles.length, entityById.size, quality) });
	return files;
}

function stripDirectoryPrefix(path: string, prefix: string): string {
	return path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
}

function renderRootIndex(
	collection: CollectionRow,
	articles: ArticleRow[],
	entityById: Map<string, EntityRow>,
	articlePaths: Map<string, string>,
	entityPaths: Map<string, string>,
): string {
	const lines = [
		frontmatter({ okf_version: '0.1' }),
		`# ${collection.name}`,
		collection.description ?? '',
		'## Articles',
		...articles.map((article) =>
			indexEntry(article.title_cn || article.title, articlePaths.get(article.id)!, article.summary_cn || article.summary),
		),
	];
	if (entityById.size > 0) {
		lines.push(
			'',
			'## Entities',
			...[...entityById.values()].map((entity) => indexEntry(entity.name, entityPaths.get(entity.id)!, entity.name_cn)),
		);
	}
	return compactMarkdown(lines);
}

function renderDirectoryIndex(title: string, entries: string[]): string {
	return compactMarkdown([`# ${title}`, ...entries]);
}

function renderArticle(article: ArticleRow, entities: EntityRow[], entityPaths: Map<string, string>): string {
	const title = article.title_cn || article.title;
	const summary = article.summary_cn || article.summary;
	const content = article.content || article.content_cn || summary || '';
	const entityLinks = uniqueBy(entities, (entity) => entity.id).map((entity) => `- [${entity.name}](/${entityPaths.get(entity.id)})`);
	return compactMarkdown([
		frontmatter({
			type: 'Article',
			title,
			description: summary,
			resource: article.url,
			tags: article.tags?.length ? article.tags : undefined,
			keywords: article.keywords?.length ? article.keywords : undefined,
			timestamp: toIso(article.published_date),
			source: article.source,
			source_type: article.source_type,
			title_cn: article.title_cn,
			description_cn: article.summary_cn,
		}),
		`# ${title}`,
		summary ?? '',
		entityLinks.length ? '## Linked entities' : '',
		...entityLinks,
		content,
		'# Citations',
		`[1] [${article.source || article.url}](${article.url})`,
	]);
}

function renderEntity(entity: EntityRow, links: EntityRow[], articles: ArticleRow[], articlePaths: Map<string, string>): string {
	const articleById = new Map(articles.map((article) => [article.id, article]));
	const articleLinks = uniqueBy(links, (link) => link.article_id)
		.map((link) => articleById.get(link.article_id))
		.filter((article): article is ArticleRow => !!article)
		.map((article) => `- [${article.title_cn || article.title}](/${articlePaths.get(article.id)})`);
	return compactMarkdown([
		frontmatter({
			type: entity.type,
			title: entity.name,
			name_cn: entity.name_cn,
			tags: [entity.type],
			newsence_entity_id: entity.id,
			newsence_article_count: entity.article_count,
		}),
		`# ${entity.name}`,
		entity.name_cn ? `Chinese name: ${entity.name_cn}` : '',
		'## Mentioned in',
		...articleLinks,
	]);
}

function renderLog(collection: CollectionRow, articleCount: number, entityCount: number, quality: EntityQualityStats): string {
	const today = new Date().toISOString().slice(0, 10);
	const unknownTypes = Object.entries(quality.unknownTypes).map(([type, count]) => `  * ${type}: ${count}`);
	return compactMarkdown([
		'# Directory Update Log',
		`## ${today}`,
		`* **Export**: Generated OKF bundle for "${collection.name}" with ${articleCount} articles and ${entityCount} entity pages.`,
		'* **Entity quality gate**:',
		`  * Total article-entity links read: ${quality.totalLinks}`,
		`  * Exported links: ${quality.exportedLinks}`,
		`  * Filtered self-source links: ${quality.filteredSelfSource}`,
		`  * Filtered generic-token links: ${quality.filteredGeneric}`,
		`  * Filtered too-short links: ${quality.filteredTooShort}`,
		`  * Articles with entity JSON but no join-table links: ${quality.jsonWithoutLinksArticles}`,
		`  * Articles without join-table entity links: ${quality.articlesWithoutEntityLinks}`,
		unknownTypes.length ? '* **Unknown entity types preserved by OKF tolerance**:' : '',
		...unknownTypes,
		'* **Producer notes**: category is not a first-class stored column; current ingestion folds classification category into tags. keywords are emitted as an extension frontmatter key.',
	]);
}

function indexEntry(title: string, path: string, description: string | null | undefined): string {
	return `* [${title}](${path})${description ? ` - ${oneLine(description)}` : ''}`;
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
		const base = slugify(item.label) || item.id.slice(0, 8);
		let slug = base;
		for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
		used.add(slug);
		paths.set(item.id, `${prefix}/${slug}.md`);
	}
	return paths;
}

function uniqueSlug(label: string, id: string): string {
	return `${slugify(label) || 'collection'}-${id.slice(0, 8)}`;
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

function tarGzipStream(files: OkfFile[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const file of files) enqueueTarFile(controller, file);
			controller.enqueue(new Uint8Array(1024));
			controller.close();
		},
	}).pipeThrough(new CompressionStream('gzip'));
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
