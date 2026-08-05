import type {
	CorpusFsEntry,
	CorpusFsListRequest,
	CorpusFsReaderPage,
	CorpusFsReaderRpcResult,
	CorpusFsReadResult,
	CorpusFsResourceReadRequest,
} from '@chat/fs/contracts';
import { CorpusFsReaderOutputBudgetError, fitCorpusFsReadChunk } from '@chat/fs/read-chunk';
import {
	decodeCorpusFsReaderCursor,
	encodeCorpusFsReaderCursor,
	InvalidCorpusFsReaderCursorError,
	isCorpusFsCursorTimestamp,
} from '@chat/fs/reader-cursor';
import { parseResourceIdentity } from '@core-shared/resource-types';
import { type CoreDb, isValidUuid, queryRows, uuidArraySql, withCoreDb } from '@db/client';
import { contentResourceIdentitySql, resourceDisplaySourceSql } from '@db/resource-identity-sql';
import { type SQL, sql } from 'drizzle-orm';

const MAX_FS_READ_BYTES = 65_536;
const MAX_METADATA_ARRAY_ITEMS = 8;
const MAX_METADATA_ITEM_CHARS = 64;
const MAX_METADATA_SUMMARY_CHARS = 800;
const MAX_METADATA_URL_CHARS = 1_024;
const MAX_TITLE_CHARS = 512;
const MAX_RESOURCE_RESOLVE_IDS = 50;
// PostgreSQL's text SUBSTRING start argument is int4. Leave room for the
// one-based offset conversion performed when the query is assembled.
const MAX_RESOURCE_CURSOR_OFFSET = 2_147_483_646;

type ResourceAccess = { access: 'principal'; userId: string } | { access: 'public'; userId: null };

export type ResolveCorpusFsResourceEntriesInput = ResourceAccess & {
	ids: string[];
	preferredLocale: string | null;
};

interface CollectionCursor {
	resourceId: string;
	sortAt: string;
}

interface ResourceCursor {
	contentOffset: number;
	lang: string;
	resourceId: string;
	resourceUpdatedAt: string;
	translationUpdatedAt: string;
}

interface CollectionRow {
	id: string;
	sort_at: string;
	title: string | null;
}

interface ResourceEntryRow {
	id: string;
	title: string | null;
}

interface ResourceReadRow {
	content_chars: number | string | null;
	content_chunk: string | null;
	file_type: string | null;
	id: string;
	keywords: string[] | null;
	kind: string;
	original_lang: string;
	published_date: Date | string | null;
	resource_platform: string | null;
	resource_updated_at: string;
	scope: string;
	selected_lang: string | null;
	source: string | null;
	summary: string | null;
	tags: string[] | null;
	title: string | null;
	translation_updated_at: string | null;
	url: string | null;
	viewer_has_ownership: boolean;
}

function rpcOk<T>(value: T): CorpusFsReaderRpcResult<T> {
	return { status: 'ok', value };
}

async function cursorRpc<T>(run: () => Promise<T>): Promise<CorpusFsReaderRpcResult<T>> {
	try {
		return rpcOk(await run());
	} catch (error) {
		if (error instanceof InvalidCorpusFsReaderCursorError) return { status: 'invalid-cursor' };
		if (error instanceof CorpusFsReaderOutputBudgetError) return { status: 'output-budget-exceeded' };
		throw error;
	}
}

function decodeCollectionCursor(cursor: string | undefined, collectionId: string): CollectionCursor | null {
	if (!cursor) return null;
	const value = decodeCorpusFsReaderCursor(cursor);
	if (
		value.length !== 4 ||
		value[0] !== 'collection-fs-v1' ||
		value[1] !== collectionId ||
		!isCorpusFsCursorTimestamp(value[2]) ||
		typeof value[3] !== 'string' ||
		!isValidUuid(value[3])
	) {
		throw new InvalidCorpusFsReaderCursorError();
	}
	return { resourceId: value[3], sortAt: value[2] };
}

function decodeResourceCursor(cursor: string | undefined, resourceId: string): ResourceCursor | null {
	if (!cursor) return null;
	const value = decodeCorpusFsReaderCursor(cursor);
	if (
		value.length !== 6 ||
		value[0] !== 'resource-fs-v1' ||
		value[1] !== resourceId ||
		typeof value[2] !== 'string' ||
		!value[2] ||
		!isCorpusFsCursorTimestamp(value[3]) ||
		!isCorpusFsCursorTimestamp(value[4]) ||
		!Number.isSafeInteger(value[5]) ||
		(value[5] as number) < 0 ||
		(value[5] as number) > MAX_RESOURCE_CURSOR_OFFSET
	) {
		throw new InvalidCorpusFsReaderCursorError();
	}
	return {
		contentOffset: value[5] as number,
		lang: value[2],
		resourceId,
		resourceUpdatedAt: value[3],
		translationUpdatedAt: value[4],
	};
}

function assertListInput(input: CorpusFsListRequest): void {
	if (
		!isValidUuid(input.id) ||
		input.path !== `/corpus/collections/${input.id}` ||
		!input.userId ||
		input.limit < 1 ||
		input.limit > 50 ||
		!Number.isInteger(input.limit)
	) {
		throw new Error('Invalid corpus filesystem list request');
	}
}

function assertResourceReadInput(input: CorpusFsResourceReadRequest): void {
	if (
		!isValidUuid(input.id) ||
		input.path !== `/corpus/resources/${input.id}` ||
		!Number.isInteger(input.maxBytes) ||
		input.maxBytes < 256 ||
		input.maxBytes > MAX_FS_READ_BYTES
	) {
		throw new Error('Invalid corpus filesystem resource read request');
	}
	if (input.access === 'principal' ? !input.userId : input.userId !== null) {
		throw new Error('Invalid corpus filesystem resource principal');
	}
}

function validResourceIdentitySql(): SQL {
	return sql`(
		${contentResourceIdentitySql({ kind: sql`r.kind`, resourcePlatform: sql`r.resource_platform` })}
		OR (r.kind = 'image' AND r.resource_platform IS NULL)
		OR (r.kind = 'file' AND r.resource_platform IS NULL)
	)`;
}

function viewerResourceOwnershipSql(userId: string): SQL {
	return sql`(
		EXISTS (
			SELECT 1 FROM resource_saves content_save
			WHERE content_save.resource_id = r.id AND content_save.user_id = ${userId}
		)
		OR EXISTS (
			SELECT 1 FROM user_files content_file
			WHERE content_file.resource_id = r.id AND content_file.user_id = ${userId}
		)
	)`;
}

function viewerContainerMembershipSql(userId: string): SQL {
	return sql`(
		EXISTS (
			SELECT 1
			FROM collection_resources membership
			JOIN collections owned_collection ON owned_collection.id = membership.collection_id
			WHERE membership.resource_id = r.id AND owned_collection.user_id = ${userId}
		)
		OR EXISTS (
			SELECT 1
			FROM workspace_resources membership
			JOIN workspaces owned_workspace ON owned_workspace.id = membership.workspace_id
			WHERE membership.resource_id = r.id AND owned_workspace.user_id = ${userId}
		)
	)`;
}

function publicCorpusSql(): SQL {
	return sql`(r.scope = 'corpus' AND r.enrichment_status = 'enriched')`;
}

function resourceMetadataAccessSql(access: ResourceAccess): SQL {
	if (access.access === 'public') return sql`(${validResourceIdentitySql()} AND ${publicCorpusSql()})`;
	return sql`(
		${validResourceIdentitySql()}
		AND (
			${publicCorpusSql()}
			OR ${viewerResourceOwnershipSql(access.userId)}
			OR ${viewerContainerMembershipSql(access.userId)}
		)
	)`;
}

function localizedTranslationSql(preferredLocale: string | null, selectedLang?: string): SQL {
	return sql`
		LEFT JOIN LATERAL (
			SELECT translation.lang,
			       translation.title,
			       translation.summary,
			       translation.content,
			       translation.keywords,
			       TO_CHAR(
			         translation.updated_at AT TIME ZONE 'UTC',
			         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
			       ) AS updated_at
			FROM resource_translations translation
			WHERE translation.resource_id = r.id
			  ${selectedLang ? sql`AND translation.lang = ${selectedLang}` : sql``}
			ORDER BY CASE
			           WHEN translation.lang = ${preferredLocale ?? ''} THEN 0
			           WHEN translation.lang = r.original_lang THEN 1
			           ELSE 2
			         END,
			         translation.lang ASC
			LIMIT 1
		) localized ON TRUE
	`;
}

function displaySourceSql(): SQL {
	return resourceDisplaySourceSql({
		kind: sql`r.kind`,
		monitoredSourceName: sql`monitored_source.name`,
		platformMetadata: sql`r.platform_metadata`,
		resourcePlatform: sql`r.resource_platform`,
	});
}

function titleForRow(title: string | null): string {
	return title?.trim().slice(0, MAX_TITLE_CHARS) || 'Untitled resource';
}

function resourceEntry(row: ResourceEntryRow): CorpusFsEntry {
	return {
		id: row.id,
		path: `/corpus/resources/${row.id}`,
		title: titleForRow(row.title),
		type: 'resource',
	};
}

function limitedStrings(values: string[] | null): string[] | undefined {
	if (!values?.length) return undefined;
	return values.slice(0, MAX_METADATA_ARRAY_ITEMS).map((value) => value.slice(0, MAX_METADATA_ITEM_CHARS));
}

function optionalIsoDate(value: Date | string | null): string | undefined {
	if (value === null) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

function fitResourceResult(input: {
	contentChunk: string;
	contentOffset: number;
	contentTotal: number;
	maxBytes: number;
	metadata: Record<string, unknown>;
	resourceId: string;
	revision: { lang: string; resourceUpdatedAt: string; translationUpdatedAt: string };
	title: string;
}): CorpusFsReadResult {
	return fitCorpusFsReadChunk({
		build: (content, nextOffset): CorpusFsReadResult => ({
			...(content === undefined ? {} : { content }),
			id: input.resourceId,
			metadata: input.metadata,
			nextCursor:
				nextOffset < input.contentTotal
					? encodeCorpusFsReaderCursor([
							'resource-fs-v1',
							input.resourceId,
							input.revision.lang,
							input.revision.resourceUpdatedAt,
							input.revision.translationUpdatedAt,
							nextOffset,
						])
					: null,
			path: `/corpus/resources/${input.resourceId}`,
			title: input.title,
			type: 'resource',
		}),
		content: input.contentChunk,
		contentOffset: input.contentOffset,
		maxBytes: input.maxBytes,
	});
}

function collectionCursorPredicate(cursor: CollectionCursor | null): SQL {
	if (!cursor) return sql``;
	return sql`
		AND (
			edge.added_at < ${cursor.sortAt}::timestamptz
			OR (edge.added_at = ${cursor.sortAt}::timestamptz AND edge.resource_id < ${cursor.resourceId}::uuid)
		)
	`;
}

async function listCollection(db: CoreDb, input: CorpusFsListRequest): Promise<CorpusFsReaderPage | null> {
	assertListInput(input);
	const cursor = decodeCollectionCursor(input.cursor, input.id);
	const collectionRows = await queryRows<{ description: string | null; id: string; title: string }>(
		db,
		sql`
			SELECT collection.id::text, collection.name AS title, collection.description
			FROM collections collection
			WHERE collection.id = ${input.id}::uuid AND collection.user_id = ${input.userId}
			LIMIT 1
		`,
	);
	const collection = collectionRows[0];
	if (!collection) return null;

	const access = { access: 'principal' as const, userId: input.userId };
	const rows = await queryRows<CollectionRow>(
		db,
		sql`
			SELECT edge.resource_id::text AS id,
			       TO_CHAR(edge.added_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,
			       COALESCE(NULLIF(BTRIM(localized.title), ''), NULLIF(BTRIM(r.url), ''), 'Untitled resource') AS title
			FROM collection_resources edge
			JOIN resources r ON r.id = edge.resource_id
			LEFT JOIN sources monitored_source ON monitored_source.id = r.source_id
			${localizedTranslationSql(input.preferredLocale)}
			WHERE edge.collection_id = ${input.id}::uuid
			  AND ${resourceMetadataAccessSql(access)}
			  ${collectionCursorPredicate(cursor)}
			ORDER BY edge.added_at DESC, edge.resource_id DESC
			LIMIT ${input.limit + 1}
		`,
	);
	const hasNext = rows.length > input.limit;
	const pageRows = rows.slice(0, input.limit);
	const last = pageRows.at(-1);
	return {
		entries: pageRows.map(resourceEntry),
		metadata: {
			description: collection.description?.slice(0, 2_000) ?? null,
			id: collection.id,
			title: collection.title.trim().slice(0, MAX_TITLE_CHARS) || 'Untitled collection',
		},
		nextCursor: hasNext && last ? encodeCorpusFsReaderCursor(['collection-fs-v1', collection.id, last.sort_at, last.id]) : null,
	};
}

export async function listCorpusFsCollection(
	env: CoreEnv,
	input: CorpusFsListRequest,
): Promise<CorpusFsReaderRpcResult<CorpusFsReaderPage | null>> {
	return cursorRpc(() => withCoreDb(env, (db) => listCollection(db, input)));
}

async function resolveResourceEntries(db: CoreDb, input: ResolveCorpusFsResourceEntriesInput): Promise<CorpusFsEntry[]> {
	const ids = [...new Set(input.ids)];
	if (ids.length > MAX_RESOURCE_RESOLVE_IDS || ids.some((id) => !isValidUuid(id))) return [];
	if (input.access === 'principal' ? !input.userId : input.userId !== null) return [];
	if (ids.length === 0) return [];
	const rows = await queryRows<ResourceEntryRow>(
		db,
		sql`
			SELECT r.id::text,
			       COALESCE(NULLIF(BTRIM(localized.title), ''), NULLIF(BTRIM(r.url), ''), 'Untitled resource') AS title
			FROM resources r
			${localizedTranslationSql(input.preferredLocale)}
			WHERE r.id = ANY(${uuidArraySql(ids)})
			  AND ${resourceMetadataAccessSql(input)}
		`,
	);
	return rows.map(resourceEntry);
}

export async function resolveCorpusFsResourceEntries(env: CoreEnv, input: ResolveCorpusFsResourceEntriesInput): Promise<CorpusFsEntry[]> {
	return withCoreDb(env, (db) => resolveResourceEntries(db, input));
}

function resourceReadMetadata(row: ResourceReadRow) {
	const identity = parseResourceIdentity(row.kind, row.resource_platform);
	if (!identity) throw new Error(`Corpus resource ${row.id} has an invalid persisted identity`);
	const publishedDate = optionalIsoDate(row.published_date);
	const keywords = limitedStrings(row.keywords);
	const tags = limitedStrings(row.tags);
	return {
		fileType: row.file_type,
		kind: identity.kind,
		...(keywords ? { keywords } : {}),
		originalLang: row.original_lang,
		...(publishedDate ? { publishedDate } : {}),
		resourcePlatform: identity.resourcePlatform,
		scope: row.scope,
		source: row.source?.trim().slice(0, 256) || 'Resource',
		...(row.summary ? { summary: row.summary.slice(0, MAX_METADATA_SUMMARY_CHARS) } : {}),
		...(tags ? { tags } : {}),
		translationLang: row.selected_lang,
		...(row.url ? { url: row.url.slice(0, MAX_METADATA_URL_CHARS) } : {}),
	};
}

async function readResource(db: CoreDb, input: CorpusFsResourceReadRequest): Promise<CorpusFsReadResult | null> {
	assertResourceReadInput(input);
	const cursor = decodeResourceCursor(input.cursor, input.id);
	const offset = cursor?.contentOffset ?? 0;
	const ownership = input.access === 'principal' ? viewerResourceOwnershipSql(input.userId) : sql`FALSE`;
	const rows = await queryRows<ResourceReadRow>(
		db,
		sql`
			SELECT r.id::text,
			       r.kind,
			       r.resource_platform,
			       r.scope,
			       r.url,
			       r.file_type,
			       r.original_lang,
			       COALESCE(r.published_date, r.scraped_date, r.created_at) AS published_date,
			       ${displaySourceSql()} AS source,
			       r.tags,
			       localized.title,
			       localized.summary,
			       localized.keywords,
			       localized.lang AS selected_lang,
			       TO_CHAR(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS resource_updated_at,
			       localized.updated_at AS translation_updated_at,
			       ${ownership} AS viewer_has_ownership,
			       CASE WHEN ${ownership} THEN CHAR_LENGTH(localized.content) ELSE NULL END AS content_chars,
			       CASE WHEN ${ownership}
			         THEN SUBSTRING(localized.content FROM ${offset + 1} FOR ${input.maxBytes})
			         ELSE NULL
			       END AS content_chunk
			FROM resources r
			LEFT JOIN sources monitored_source ON monitored_source.id = r.source_id
			${localizedTranslationSql(input.preferredLocale, cursor?.lang)}
			WHERE r.id = ${input.id}::uuid
			  AND ${resourceMetadataAccessSql(input)}
			LIMIT 1
		`,
	);
	const row = rows[0];
	if (!row) return null;
	if (!row.selected_lang || !row.translation_updated_at) {
		if (cursor) throw new InvalidCorpusFsReaderCursorError();
		return {
			id: row.id,
			metadata: resourceReadMetadata(row),
			nextCursor: null,
			path: input.path,
			title: titleForRow(row.title),
			type: 'resource',
		};
	}
	if (
		cursor &&
		(cursor.lang !== row.selected_lang ||
			cursor.resourceUpdatedAt !== row.resource_updated_at ||
			cursor.translationUpdatedAt !== row.translation_updated_at)
	) {
		throw new InvalidCorpusFsReaderCursorError();
	}
	const contentTotal = Number(row.content_chars ?? 0);
	if (!Number.isSafeInteger(contentTotal) || contentTotal < 0 || (cursor && offset >= contentTotal)) {
		throw new InvalidCorpusFsReaderCursorError();
	}
	if (!row.viewer_has_ownership || !row.content_chunk || contentTotal === 0) {
		return {
			id: row.id,
			metadata: resourceReadMetadata(row),
			nextCursor: null,
			path: input.path,
			title: titleForRow(row.title),
			type: 'resource',
		};
	}
	return fitResourceResult({
		contentChunk: row.content_chunk,
		contentOffset: offset,
		contentTotal,
		maxBytes: input.maxBytes,
		metadata: resourceReadMetadata(row),
		resourceId: row.id,
		revision: {
			lang: row.selected_lang,
			resourceUpdatedAt: row.resource_updated_at,
			translationUpdatedAt: row.translation_updated_at,
		},
		title: titleForRow(row.title),
	});
}

export async function readCorpusFsResource(
	env: CoreEnv,
	input: CorpusFsResourceReadRequest,
): Promise<CorpusFsReaderRpcResult<CorpusFsReadResult | null>> {
	return cursorRpc(() => withCoreDb(env, (db) => readResource(db, input)));
}
