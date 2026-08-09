import {
	decodeKnowledgeContinuation,
	encodeKnowledgeContinuation,
	fitKnowledgeReadChunk,
	InvalidKnowledgeContinuationError,
	isKnowledgeContinuationTimestamp,
	KnowledgeOutputBudgetError,
	type KnowledgeReaderRpcResult,
	type KnowledgeReadResult,
	type KnowledgeResolveResourcesInput,
	type KnowledgeResourceReadInput,
	type KnowledgeSourceEntry,
} from '@app-domain/knowledge-contracts';
import { parseResourceIdentity } from '@core-shared/resource-types';
import { type CoreDb, isValidUuid, queryRows, uuidArraySql, withCoreDb } from '@db/client';
import { contentResourceIdentitySql, resourceDisplaySourceSql } from '@db/resource-identity-sql';
import { type SQL, sql } from 'drizzle-orm';

const MAX_CORPUS_READ_BYTES = 65_536;
const MAX_METADATA_ARRAY_ITEMS = 8;
const MAX_METADATA_ITEM_CHARS = 64;
const MAX_METADATA_SUMMARY_CHARS = 800;
const MAX_METADATA_URL_CHARS = 1_024;
const MAX_TITLE_CHARS = 512;
const MAX_RESOURCE_RESOLVE_IDS = 50;
// PostgreSQL's text SUBSTRING start argument is int4. Cast both bound numeric
// arguments explicitly so Postgres cannot select the regex overload, and leave
// room for the one-based offset conversion performed when the query is assembled.
const MAX_RESOURCE_CONTINUATION_OFFSET = 2_147_483_646;

type ResourceAccess = { access: 'principal'; userId: string } | { access: 'public'; userId: null };

interface ResourceContinuation {
	contentOffset: number;
	lang: string;
	resourceId: string;
	resourceUpdatedAt: string;
	translationUpdatedAt: string;
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

function rpcOk<T>(value: T): KnowledgeReaderRpcResult<T> {
	return { status: 'ok', value };
}

async function continuationRpc<T>(run: () => Promise<T>): Promise<KnowledgeReaderRpcResult<T>> {
	try {
		return rpcOk(await run());
	} catch (error) {
		if (error instanceof InvalidKnowledgeContinuationError) return { status: 'invalid-continuation' };
		if (error instanceof KnowledgeOutputBudgetError) return { status: 'output-budget-exceeded' };
		throw error;
	}
}

function decodeResourceContinuation(continuation: string | undefined, resourceId: string): ResourceContinuation | null {
	if (!continuation) return null;
	const value = decodeKnowledgeContinuation(continuation);
	if (
		value.length !== 6 ||
		value[0] !== 'resource-v2' ||
		value[1] !== resourceId ||
		typeof value[2] !== 'string' ||
		!value[2] ||
		!isKnowledgeContinuationTimestamp(value[3]) ||
		!isKnowledgeContinuationTimestamp(value[4]) ||
		!Number.isSafeInteger(value[5]) ||
		(value[5] as number) < 0 ||
		(value[5] as number) > MAX_RESOURCE_CONTINUATION_OFFSET
	) {
		throw new InvalidKnowledgeContinuationError();
	}
	return {
		contentOffset: value[5] as number,
		lang: value[2],
		resourceId,
		resourceUpdatedAt: value[3],
		translationUpdatedAt: value[4],
	};
}

function assertResourceReadInput(input: KnowledgeResourceReadInput): void {
	if (
		input.ref.type !== 'resource' ||
		!isValidUuid(input.ref.id) ||
		!Number.isInteger(input.maxBytes) ||
		input.maxBytes < 256 ||
		input.maxBytes > MAX_CORPUS_READ_BYTES
	) {
		throw new Error('Invalid corpus resource read request');
	}
	if (input.access === 'principal' ? !input.userId : input.userId !== null) {
		throw new Error('Invalid corpus resource principal');
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

function resourceEntry(row: ResourceEntryRow): KnowledgeSourceEntry {
	return {
		sourceId: row.id,
		sourceType: 'resource',
		title: titleForRow(row.title),
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
}): KnowledgeReadResult {
	return fitKnowledgeReadChunk({
		build: (content, nextOffset): KnowledgeReadResult => ({
			...(content === undefined ? {} : { content }),
			contentAvailable: true,
			continuation:
				nextOffset < input.contentTotal
					? encodeKnowledgeContinuation([
							'resource-v2',
							input.resourceId,
							input.revision.lang,
							input.revision.resourceUpdatedAt,
							input.revision.translationUpdatedAt,
							nextOffset,
						])
					: null,
			metadata: input.metadata,
			sourceId: input.resourceId,
			sourceType: 'resource',
			title: input.title,
		}),
		content: input.contentChunk,
		contentOffset: input.contentOffset,
		maxBytes: input.maxBytes,
	});
}

async function resolveResourceEntries(db: CoreDb, input: KnowledgeResolveResourcesInput): Promise<KnowledgeSourceEntry[]> {
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

export async function resolveCorpusResources(env: CoreEnv, input: KnowledgeResolveResourcesInput): Promise<KnowledgeSourceEntry[]> {
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

async function readResource(db: CoreDb, input: KnowledgeResourceReadInput): Promise<KnowledgeReadResult | null> {
	assertResourceReadInput(input);
	const resourceId = input.ref.id;
	const continuation = decodeResourceContinuation(input.continuation, resourceId);
	const offset = continuation?.contentOffset ?? 0;
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
			         THEN SUBSTRING(
			           localized.content
			           FROM (${offset + 1})::integer
			           FOR (${input.maxBytes})::integer
			         )
			         ELSE NULL
			       END AS content_chunk
			FROM resources r
			LEFT JOIN sources monitored_source ON monitored_source.id = r.source_id
			${localizedTranslationSql(input.preferredLocale, continuation?.lang)}
			WHERE r.id = ${resourceId}::uuid
			  AND ${resourceMetadataAccessSql(input)}
			LIMIT 1
		`,
	);
	const row = rows[0];
	if (!row) return null;
	if (!row.selected_lang || !row.translation_updated_at) {
		if (continuation) throw new InvalidKnowledgeContinuationError();
		return {
			contentAvailable: false,
			continuation: null,
			metadata: resourceReadMetadata(row),
			sourceId: row.id,
			sourceType: 'resource',
			title: titleForRow(row.title),
		};
	}
	if (
		continuation &&
		(continuation.lang !== row.selected_lang ||
			continuation.resourceUpdatedAt !== row.resource_updated_at ||
			continuation.translationUpdatedAt !== row.translation_updated_at)
	) {
		throw new InvalidKnowledgeContinuationError();
	}
	const contentTotal = Number(row.content_chars ?? 0);
	if (!Number.isSafeInteger(contentTotal) || contentTotal < 0 || (continuation && offset >= contentTotal)) {
		throw new InvalidKnowledgeContinuationError();
	}
	if (!row.viewer_has_ownership || !row.content_chunk || contentTotal === 0) {
		return {
			contentAvailable: false,
			continuation: null,
			metadata: resourceReadMetadata(row),
			sourceId: row.id,
			sourceType: 'resource',
			title: titleForRow(row.title),
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

export async function readCorpusResource(
	env: CoreEnv,
	input: KnowledgeResourceReadInput,
): Promise<KnowledgeReaderRpcResult<KnowledgeReadResult | null>> {
	return continuationRpc(() => withCoreDb(env, (db) => readResource(db, input)));
}
