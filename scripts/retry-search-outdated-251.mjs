import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';

const NAMESPACE = 'default';
const INDEX_NAME = 'newsence-corpus-v6';
const STATE_INDEX_NAME = 'public-corpus-v6';
const GENERATION = 4;
const GENERATION_KEY = 'canonical-4-kind-platform';
const ITEM_PREFIX = 'resources/';
const ITEM_SUFFIX = '.md';
const NULL_RESOURCE_PLATFORM_METADATA = 'none';
const TERMINAL_STATUSES = ['error', 'outdated'];
const IN_PROGRESS_STATUSES = ['queued', 'running'];
const NON_COMPLETED_STATUSES = [...IN_PROGRESS_STATUSES, ...TERMINAL_STATUSES, 'skipped'];
const PER_PAGE = 50;
const LOG_PAGE_SIZE = 100;
const SNAPSHOT_STABILIZATION_MS = 2_000;
const ITEM_POLL_INTERVAL_MS = 2_000;
const ITEM_POLL_ATTEMPTS = 90;
const PATCH_TIMEOUT_MS = 60_000;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const LOG_CLOCK_SKEW_MS = 5_000;
const APPLY_ADVISORY_LOCK = [251, 1];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ITEM_ID = /^[0-9a-f]{32}$/;
const EXPECTED_CUSTOM_METADATA = [
	{ field_name: 'effective_at', data_type: 'datetime' },
	{ field_name: 'source_id', data_type: 'text' },
	{ field_name: 'category', data_type: 'text' },
	{ field_name: 'kind', data_type: 'text' },
	{ field_name: 'resource_platform', data_type: 'text' },
];

const argumentsList = process.argv.slice(2);
const capture = argumentsList.includes('--capture');
const apply = argumentsList.includes('--apply');
assert.notEqual(capture, apply, 'Select exactly one mode: --capture or --apply');
const checkpointArguments = argumentsList.filter((argument) => argument.startsWith('--checkpoint='));
const approvalArguments = argumentsList.filter((argument) => argument.startsWith('--approval-digest='));
const outputArguments = argumentsList.filter((argument) => argument.startsWith('--output='));
assert.ok(checkpointArguments.length <= 1, 'checkpoint argument is unique');
assert.ok(approvalArguments.length <= 1, 'approval digest argument is unique');
assert.ok(outputArguments.length <= 1, 'output argument is unique');
const checkpointPath = checkpointArguments[0]?.slice('--checkpoint='.length) ?? null;
const approvalDigest = approvalArguments[0]?.slice('--approval-digest='.length) ?? null;
const outputPath = outputArguments[0]?.slice('--output='.length) ?? null;
assert.deepEqual(
	argumentsList.filter(
		(argument) =>
			!['--capture', '--apply'].includes(argument) &&
			!argument.startsWith('--checkpoint=') &&
			!argument.startsWith('--approval-digest=') &&
			!argument.startsWith('--output='),
	),
	[],
	'unknown operator arguments',
);
if (capture) {
	assert.equal(checkpointPath, null, 'capture does not accept a checkpoint');
	assert.equal(approvalDigest, null, 'capture does not accept an approval digest');
	assert.equal(outputArguments.length, 1, 'capture requires exactly one --output=<absolute-path>');
	assert.ok(outputPath, 'capture output path is non-empty');
	assert.equal(isAbsolute(outputPath), true, 'capture output path is absolute');
} else {
	assert.ok(checkpointPath, 'apply requires --checkpoint=<path>');
	assert.equal(outputPath, null, 'apply does not accept an output path');
	assert.match(approvalDigest ?? '', /^[0-9a-f]{64}$/, 'apply requires --approval-digest=<sha256>');
}

function credentials() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const apiToken = process.env.CLOUDFLARE_AISEARCH_API_TOKEN?.trim();
	assert.match(accountId ?? '', /^[0-9a-f]{32}$/, 'Set CLOUDFLARE_ACCOUNT_ID');
	assert.ok(apiToken, 'Set CLOUDFLARE_AISEARCH_API_TOKEN with AI Search Edit and Run');
	return { accountId, apiToken };
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	assert.ok(value, 'Set the direct PostgreSQL connection string');
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

function instanceUrl(accountId) {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/namespaces/${NAMESPACE}/instances/${INDEX_NAME}`;
}

function itemsUrl(accountId, suffix = '') {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/namespaces/${NAMESPACE}/instances/${INDEX_NAME}/items${suffix}`;
}

function statsUrl(accountId) {
	return `${instanceUrl(accountId)}/stats`;
}

function retryDelay(response, attempt) {
	const seconds = Number(response.headers.get('retry-after'));
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1_000, 20_000) : Math.min(500 * 2 ** attempt, 5_000);
}

async function cloudflareGet(url, apiToken, label, attempt = 0) {
	const response = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
	if (response.status === 429 && attempt < 6) {
		const delay = retryDelay(response, attempt);
		await response.text();
		await sleep(delay);
		return cloudflareGet(url, apiToken, label, attempt + 1);
	}
	const payload = await response.json();
	assert.equal(response.ok, true, `${label} HTTP ${response.status}: ${JSON.stringify(payload.errors ?? [])}`);
	assert.equal(payload.success, true, `${label} API`);
	return payload;
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

async function syncMutation(accountId, apiToken, target) {
	const url = itemsUrl(accountId, `/${target.item.itemId}`);
	try {
		const response = await fetch(url, {
			body: JSON.stringify({ next_action: 'INDEX', wait_for_completion: true }),
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
			method: 'PATCH',
			signal: AbortSignal.timeout(PATCH_TIMEOUT_MS),
		});
		const responseText = await response.text();
		let payload = null;
		try {
			payload = JSON.parse(responseText);
		} catch {
			// A delivered mutation with an unparseable response is ambiguous.
		}
		const resultIsObject = payload?.result && typeof payload.result === 'object';
		return {
			acknowledged: response.ok && payload?.success === true && resultIsObject,
			ambiguous: !(response.ok && payload?.success === true && resultIsObject),
			cfRay: response.headers.get('cf-ray'),
			error:
				response.ok && payload?.success === true
					? resultIsObject
						? null
						: 'successful response contained no item result'
					: `HTTP ${response.status}: ${JSON.stringify(payload?.errors ?? [])}`,
			httpStatus: response.status,
			responseDigest: sha256(responseText),
			result: resultIsObject
				? {
						id: payload.result.id ?? null,
						key: payload.result.key ?? null,
						status: payload.result.status ?? null,
					}
				: null,
		};
	} catch (error) {
		return {
			acknowledged: false,
			ambiguous: true,
			cfRay: null,
			error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			httpStatus: null,
			responseDigest: null,
			result: null,
		};
	}
}

async function downloadItemContent(accountId, apiToken, itemId, label, attempt = 0) {
	const response = await fetch(itemsUrl(accountId, `/${itemId}/download`), {
		headers: { Authorization: `Bearer ${apiToken}` },
	});
	if (response.status === 429 && attempt < 6) {
		const delay = retryDelay(response, attempt);
		await response.text();
		await sleep(delay);
		return downloadItemContent(accountId, apiToken, itemId, label, attempt + 1);
	}
	if (!response.ok) {
		const responseText = await response.text();
		assert.fail(`${label} content HTTP ${response.status}: ${responseText.slice(0, 500)}`);
	}
	const content = Buffer.from(await response.arrayBuffer());
	assert.ok(content.byteLength > 0 && content.byteLength <= MAX_CONTENT_BYTES, `${label} content byte length`);
	return {
		byteLength: content.byteLength,
		sha256: sha256(content),
	};
}

async function listStatusItems(accountId, apiToken, status) {
	const items = [];
	let expectedTotal = null;
	for (let page = 1; ; page++) {
		const url = new URL(itemsUrl(accountId));
		url.searchParams.set('page', String(page));
		url.searchParams.set('per_page', String(PER_PAGE));
		url.searchParams.set('source', 'builtin');
		url.searchParams.set('status', status);
		const payload = await cloudflareGet(url, apiToken, `${status} items page ${page}`);
		assert.ok(Array.isArray(payload.result), `${status} items result`);
		const totalCount = payload.result_info?.total_count;
		assert.ok(Number.isSafeInteger(totalCount) && totalCount >= 0, `${status} total count`);
		expectedTotal ??= totalCount;
		assert.equal(totalCount, expectedTotal, `${status} total count remained stable`);
		for (const item of payload.result) {
			assert.equal(item.status, status, `${status} item status`);
			assert.equal(item.source_id, 'builtin', `${status} item source`);
			items.push(item);
		}
		if (items.length >= expectedTotal) break;
		assert.ok(payload.result.length > 0, `${status} pagination made progress`);
	}
	assert.equal(items.length, expectedTotal, `${status} item paging complete`);
	assert.equal(new Set(items.map((item) => item.id)).size, items.length, `${status} item IDs are unique`);
	return items;
}

function resourceIdFromKey(key) {
	if (typeof key !== 'string' || !key.startsWith(ITEM_PREFIX) || !key.endsWith(ITEM_SUFFIX)) return null;
	const resourceId = key.slice(ITEM_PREFIX.length, -ITEM_SUFFIX.length);
	return UUID.test(resourceId) ? resourceId : null;
}

function normalizeMetadata(metadata, label) {
	assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata), `${label} metadata`);
	const normalized = {};
	for (const key of Object.keys(metadata).sort()) {
		const value = metadata[key];
		assert.ok(['string', 'number', 'boolean'].includes(typeof value), `${label} metadata ${key}`);
		normalized[key] = value;
	}
	return normalized;
}

function normalizeItem(item, label) {
	assert.match(item?.id ?? '', ITEM_ID, `${label} item ID`);
	const resourceId = resourceIdFromKey(item.key);
	assert.ok(resourceId, `${label} canonical resource key`);
	assert.equal(item.source_id, 'builtin', `${label} source`);
	assert.ok(['queued', 'running', 'completed', 'error', 'skipped', 'outdated'].includes(item.status), `${label} status`);
	assert.equal(typeof item.checksum, 'string', `${label} checksum`);
	assert.ok(Number.isSafeInteger(item.chunks_count) && item.chunks_count >= 0, `${label} chunks count`);
	assert.ok(Number.isSafeInteger(item.file_size) && item.file_size >= 0, `${label} file size`);
	assert.equal(typeof item.created_at, 'string', `${label} created timestamp`);
	assert.equal(typeof item.last_seen_at, 'string', `${label} last-seen timestamp`);
	return {
		itemId: item.id,
		resourceId,
		key: item.key,
		sourceId: item.source_id,
		status: item.status,
		error: item.error?.trim() || null,
		nextAction: item.next_action ?? null,
		checksum: item.checksum,
		chunksCount: item.chunks_count,
		fileSize: item.file_size,
		createdAt: item.created_at,
		lastSeenAt: item.last_seen_at,
		metadata: normalizeMetadata(item.metadata, label),
	};
}

function normalizeLog(log, label) {
	assert.equal(typeof log?.timestamp, 'string', `${label} log timestamp`);
	assert.equal(typeof log?.action, 'string', `${label} log action`);
	assert.equal(typeof log?.fileKey, 'string', `${label} log key`);
	return {
		timestamp: log.timestamp,
		action: log.action,
		message: log.message ?? null,
		fileKey: log.fileKey,
		chunkCount: log.chunkCount ?? null,
		processingTimeMs: log.processingTimeMs ?? null,
		errorType: log.errorType ?? null,
		errorMessage: log.errorMessage ?? null,
	};
}

function logSignature(log) {
	return JSON.stringify(log);
}

async function loadItem(accountId, apiToken, itemId, label) {
	const payload = await cloudflareGet(itemsUrl(accountId, `/${itemId}`), apiToken, `${label} item`);
	assert.ok(payload.result, `${label} item result`);
	return normalizeItem(payload.result, label);
}

async function loadLogs(accountId, apiToken, itemId, label) {
	const logs = [];
	const observedCursors = new Set();
	let cursor = null;
	for (let page = 1; ; page++) {
		const url = new URL(itemsUrl(accountId, `/${itemId}/logs`));
		url.searchParams.set('limit', String(LOG_PAGE_SIZE));
		if (cursor) url.searchParams.set('cursor', cursor);
		const payload = await cloudflareGet(url, apiToken, `${label} logs page ${page}`);
		assert.ok(Array.isArray(payload.result), `${label} logs result`);
		logs.push(...payload.result.map((log) => normalizeLog(log, label)));
		const nextCursor = payload.result_info?.cursor?.trim() || null;
		const truncated = payload.result_info?.truncated ?? false;
		if (!nextCursor) {
			assert.equal(truncated, false, `${label} logs are not truncated without a cursor`);
			assert.ok(
				payload.result_info !== undefined || payload.result.length < LOG_PAGE_SIZE,
				`${label} logs at the page limit require pagination metadata`,
			);
			break;
		}
		assert.equal(observedCursors.has(nextCursor), false, `${label} logs cursor loop`);
		observedCursors.add(nextCursor);
		cursor = nextCursor;
	}
	assert.equal(new Set(logs.map(logSignature)).size, logs.length, `${label} log entries are unique`);
	return logs.sort((left, right) => compareAscii(logSignature(left), logSignature(right)));
}

function timestampMs(value, label) {
	if (value instanceof Date) {
		const epoch = value.getTime();
		assert.ok(Number.isFinite(epoch), `${label} timestamp`);
		return epoch;
	}
	assert.equal(typeof value, 'string', `${label} timestamp`);
	const normalized = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`;
	const epoch = Date.parse(normalized);
	assert.ok(Number.isFinite(epoch), `${label} timestamp`);
	return epoch;
}

function metadataTimestampMs(value, label) {
	if (typeof value === 'number') {
		assert.ok(Number.isFinite(value) && value > 0, `${label} metadata timestamp`);
		return value;
	}
	return timestampMs(value, `${label} metadata`);
}

function itemCustomMetadata(metadata, label) {
	const normalized = {
		effective_at: new Date(metadataTimestampMs(metadata.effective_at, `${label} effective_at`)).toISOString(),
		kind: metadata.kind,
		resource_platform: metadata.resource_platform,
	};
	assert.equal(typeof normalized.kind, 'string', `${label} metadata kind`);
	assert.equal(typeof normalized.resource_platform, 'string', `${label} metadata platform`);
	if (metadata.source_id !== undefined) {
		assert.equal(typeof metadata.source_id, 'string', `${label} metadata source_id`);
		normalized.source_id = metadata.source_id;
	}
	if (metadata.category !== undefined) {
		assert.equal(typeof metadata.category, 'string', `${label} metadata category`);
		normalized.category = metadata.category;
	}
	return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => compareAscii(left, right)));
}

function markdownSection(label, value) {
	return typeof value === 'string' && value.trim() ? `\n## ${label}\n\n${value.trim()}\n` : '';
}

function requiredDocumentText(value, field, resourceId) {
	const text = typeof value === 'string' ? value.trim() : '';
	assert.ok(text, `AI Search document ${resourceId} has ${field}`);
	return text;
}

function serializeTranslation(translation, originalLang) {
	const contentLimit = translation.lang === originalLang ? 8_000 : 4_000;
	return [
		`## ${translation.lang}`,
		translation.title?.trim() ? `Title: ${translation.title.trim()}` : '',
		translation.keywords?.length ? `Keywords: ${translation.keywords.join(', ')}` : '',
		markdownSection('Summary', translation.summary),
		markdownSection('Content', translation.content?.slice(0, contentLimit)),
	]
		.filter(Boolean)
		.join('\n\n');
}

function serializeCanonicalDocument(document) {
	const original = document.translations.find((translation) => translation.lang === document.originalLang);
	assert.ok(original, `AI Search document ${document.resourceId} has its ${document.originalLang} translation`);
	return [
		`# ${requiredDocumentText(original.title, 'title', document.resourceId)}`,
		requiredDocumentText(document.source, 'source', document.resourceId),
		document.tags?.length ? `Tags: ${document.tags.join(', ')}` : '',
		...document.translations.map((translation) => serializeTranslation(translation, document.originalLang)),
	]
		.filter(Boolean)
		.join('\n\n');
}

async function loadCanonicalResource(db, resourceId) {
	const result = await db.query(
		`SELECT
		   resource.id::text,
		   resource.source_id::text,
		   resource.kind,
		   resource.resource_platform,
		   resource.original_lang,
		   floor(extract(epoch FROM coalesce(resource.published_date, resource.scraped_date, resource.created_at)) * 1000)::bigint::text
		     AS effective_at_epoch_ms,
		   resource.tags,
		   resource.category,
		   coalesce(
		     nullif(btrim(monitored_source.name), ''),
		     nullif(btrim(resource.platform_metadata->>'sourceName'), ''),
		     CASE resource.resource_platform
		       WHEN 'twitter' THEN 'Twitter'
		       WHEN 'youtube' THEN 'YouTube'
		       WHEN 'hackernews' THEN 'Hacker News'
		     END,
		     CASE resource.kind
		       WHEN 'document' THEN 'Document'
		       WHEN 'post' THEN 'Post'
		       WHEN 'video' THEN 'Video'
		       WHEN 'paper' THEN 'Paper'
		       WHEN 'image' THEN 'Image'
		       WHEN 'file' THEN 'File'
		     END
		   ) AS display_source,
		   floor(extract(epoch FROM resource.updated_at) * 1000000)::bigint::text AS resource_updated_epoch_micros,
		   coalesce((
		     SELECT jsonb_agg(
		       jsonb_build_object(
		         'lang', translation.lang,
		         'title', translation.title,
		         'summary', translation.summary,
		         'content', translation.content,
		         'keywords', translation.keywords
		       )
		       ORDER BY (translation.lang = resource.original_lang) DESC, translation.lang
		     )
		     FROM resource_translations translation
		     WHERE translation.resource_id = resource.id
		       AND (translation.lang = resource.original_lang OR translation.lang IN ('en', 'zh-Hant'))
		   ), '[]'::jsonb) AS translations,
		   (
		     SELECT floor(extract(epoch FROM max(translation.updated_at)) * 1000000)::bigint::text
		     FROM resource_translations translation
		     WHERE translation.resource_id = resource.id
		       AND (translation.lang = resource.original_lang OR translation.lang IN ('en', 'zh-Hant'))
		   ) AS latest_translation_updated_epoch_micros
		 FROM resources resource
		 LEFT JOIN sources monitored_source ON monitored_source.id = resource.source_id
		WHERE resource.id = $1::uuid
		  AND resource.scope = 'corpus'
		  AND resource.enrichment_status = 'enriched'
		  AND (
		    (resource.kind = 'document' AND (resource.resource_platform IS NULL OR resource.resource_platform = 'hackernews'))
		    OR (resource.kind = 'post' AND resource.resource_platform = 'twitter')
		    OR (resource.kind = 'video' AND resource.resource_platform = 'youtube')
		    OR (resource.kind = 'paper' AND (resource.resource_platform IS NULL OR resource.resource_platform = 'hackernews'))
		  )`,
		[resourceId],
	);
	assert.equal(result.rowCount, 1, `${resourceId} remains an eligible enriched corpus resource`);
	const row = result.rows[0];
	const effectiveAtEpochMs = Number(row.effective_at_epoch_ms);
	const resourceUpdatedEpochMicros = Number(row.resource_updated_epoch_micros);
	const latestTranslationUpdatedEpochMicros =
		row.latest_translation_updated_epoch_micros === null ? null : Number(row.latest_translation_updated_epoch_micros);
	assert.ok(Number.isSafeInteger(effectiveAtEpochMs) && effectiveAtEpochMs > 0, `${resourceId} effective date`);
	assert.ok(Number.isSafeInteger(resourceUpdatedEpochMicros) && resourceUpdatedEpochMicros > 0, `${resourceId} resource update epoch`);
	assert.ok(
		latestTranslationUpdatedEpochMicros === null ||
			(Number.isSafeInteger(latestTranslationUpdatedEpochMicros) && latestTranslationUpdatedEpochMicros > 0),
		`${resourceId} translation update epoch`,
	);
	assert.ok(Array.isArray(row.translations) && row.translations.length > 0, `${resourceId} indexed translations`);
	const document = {
		resourceId: row.id,
		sourceId: row.source_id,
		kind: row.kind,
		resourcePlatform: row.resource_platform,
		originalLang: row.original_lang,
		effectiveAt: new Date(effectiveAtEpochMs).toISOString(),
		tags: row.tags,
		category: row.category,
		source: row.display_source,
		translations: row.translations,
	};
	const content = serializeCanonicalDocument(document);
	const contentBytes = Buffer.byteLength(content, 'utf8');
	assert.ok(contentBytes > 0 && contentBytes <= MAX_CONTENT_BYTES, `${resourceId} canonical content byte length`);
	const metadata = {
		effective_at: document.effectiveAt,
		...(document.sourceId ? { source_id: document.sourceId } : {}),
		...(document.category ? { category: document.category } : {}),
		kind: document.kind,
		resource_platform: document.resourcePlatform ?? NULL_RESOURCE_PLATFORM_METADATA,
	};
	return {
		resourceId: document.resourceId,
		sourceId: document.sourceId,
		kind: document.kind,
		resourcePlatform: document.resourcePlatform,
		originalLang: document.originalLang,
		effectiveAt: document.effectiveAt,
		category: document.category,
		source: document.source,
		resourceUpdatedEpochMicros,
		latestTranslationUpdatedEpochMicros,
		indexedTranslationCount: document.translations.length,
		canonicalContentBytes: contentBytes,
		canonicalContentSha256: sha256(content),
		canonicalMetadata: Object.fromEntries(Object.entries(metadata).sort(([left], [right]) => compareAscii(left, right))),
	};
}

async function loadDbFences(db) {
	const guardResult = await db.query(
		`SELECT frozen_at, resources_frozen_count::text
		   FROM migration_guards.resource_writes_251
		  WHERE guard_key = 'resource-writes-251'`,
	);
	const triggerResult = await db.query(
		`SELECT trigger.tgenabled
		   FROM pg_trigger trigger
		  WHERE trigger.tgrelid = 'public.resources'::regclass
		    AND trigger.tgname = 'resource_writes_251_guard'
		    AND NOT trigger.tgisinternal`,
	);
	const stateResult = await db.query(
		`SELECT index_name, generation, generation_key, status, rebuild_epoch::text, ready_at, updated_at
		   FROM search_index_states
		  WHERE index_name = $1`,
		[STATE_INDEX_NAME],
	);
	const eligibleResult = await db.query(
		`SELECT count(*)::text AS count
		   FROM resources
		  WHERE scope = 'corpus'
		    AND enrichment_status = 'enriched'
		    AND (
		      (kind = 'document' AND (resource_platform IS NULL OR resource_platform = 'hackernews'))
		      OR (kind = 'post' AND resource_platform = 'twitter')
		      OR (kind = 'video' AND resource_platform = 'youtube')
		      OR (kind = 'paper' AND (resource_platform IS NULL OR resource_platform = 'hackernews'))
		    )`,
	);
	const retryLedgerResult = await db.query(`SELECT to_regclass('migration_guards.ai_search_retry_intents_251')::text AS table_name`);
	const contractPhaseResult = await db.query(
		`SELECT
		   EXISTS (
		     SELECT 1
		     FROM pg_attribute
		     WHERE attrelid = 'public.resources'::regclass
		       AND attname = 'type'
		       AND atttypid = 'text'::regtype
		       AND attnotnull
		       AND NOT attisdropped
		   ) AS compatibility_type_live,
		   to_regclass('migration_backups.resource_type_251')::text AS contraction_backup`,
	);
	assert.equal(guardResult.rowCount, 1, '#251 writer freeze marker');
	assert.equal(triggerResult.rowCount, 1, '#251 writer freeze trigger');
	assert.equal(triggerResult.rows[0].tgenabled, 'A', '#251 writer freeze trigger is always enabled');
	assert.equal(stateResult.rowCount, 1, 'durable search state');
	const state = stateResult.rows[0];
	assert.equal(state.index_name, STATE_INDEX_NAME, 'durable state index');
	assert.equal(state.generation, GENERATION, 'durable state generation');
	assert.equal(state.generation_key, GENERATION_KEY, 'durable state generation key');
	assert.equal(state.status, 'ready', 'durable state status');
	assert.ok(state.ready_at, 'durable state ready timestamp');
	const resourcesFrozenCount = Number(guardResult.rows[0].resources_frozen_count);
	const eligibleCount = Number(eligibleResult.rows[0].count);
	assert.ok(Number.isSafeInteger(resourcesFrozenCount) && resourcesFrozenCount > 0, 'frozen resource count');
	assert.ok(Number.isSafeInteger(eligibleCount) && eligibleCount > 0, 'eligible corpus count');
	assert.equal(retryLedgerResult.rows[0]?.table_name, 'migration_guards.ai_search_retry_intents_251', '#251 retry ledger');
	assert.equal(contractPhaseResult.rows[0]?.compatibility_type_live, true, 'pre-contract resources.type compatibility column');
	assert.equal(contractPhaseResult.rows[0]?.contraction_backup, null, 'pre-contract rollback backup is absent');
	return {
		frozenAt: new Date(guardResult.rows[0].frozen_at).toISOString(),
		resourcesFrozenCount,
		eligibleCount,
		searchState: {
			indexName: state.index_name,
			generation: state.generation,
			generationKey: state.generation_key,
			status: state.status,
			rebuildEpoch: Number(state.rebuild_epoch),
			readyAt: new Date(state.ready_at).toISOString(),
			updatedAt: new Date(state.updated_at).toISOString(),
		},
		contractPhase: {
			compatibilityTypeLive: contractPhaseResult.rows[0].compatibility_type_live,
			contractionBackup: contractPhaseResult.rows[0].contraction_backup,
		},
	};
}

async function loadInstanceFence(accountId, apiToken) {
	const instance = (await cloudflareGet(instanceUrl(accountId), apiToken, 'AI Search instance')).result;
	assert.equal(instance?.id, INDEX_NAME, 'AI Search instance ID');
	assert.equal(instance?.enable, true, 'AI Search enabled');
	assert.equal(instance?.paused, false, 'AI Search unpaused');
	assert.equal(instance?.engine_version, 3, 'AI Search engine generation');
	assert.equal(instance?.index_method?.vector, true, 'AI Search vector index');
	assert.equal(instance?.index_method?.keyword, true, 'AI Search keyword index');
	assert.equal(instance?.fusion_method, 'rrf', 'AI Search fusion method');
	assert.equal(instance?.indexing_options?.keyword_tokenizer, 'trigram', 'AI Search keyword tokenizer');
	assert.deepEqual(instance?.custom_metadata, EXPECTED_CUSTOM_METADATA, 'AI Search metadata contract');
	return {
		id: instance.id,
		enabled: instance.enable,
		paused: instance.paused,
		engineVersion: instance.engine_version,
		indexMethod: {
			vector: instance.index_method.vector,
			keyword: instance.index_method.keyword,
		},
		fusionMethod: instance.fusion_method,
		keywordTokenizer: instance.indexing_options.keyword_tokenizer,
		customMetadata: instance.custom_metadata,
	};
}

async function loadStats(accountId, apiToken) {
	const stats = (await cloudflareGet(statsUrl(accountId), apiToken, 'AI Search stats')).result;
	for (const status of ['completed', 'queued', 'running', 'error', 'skipped', 'outdated']) {
		assert.ok(Number.isSafeInteger(stats?.[status]) && stats[status] >= 0, `AI Search ${status} count`);
	}
	return Object.fromEntries(['completed', ...NON_COMPLETED_STATUSES].map((status) => [status, stats[status]]));
}

function compareAscii(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

async function mapSequentially(values, operation) {
	const results = [];
	for (const value of values) results.push(await operation(value));
	return results;
}

function assertCanonicalItem(item, resource, storedContent, label) {
	assert.deepEqual(itemCustomMetadata(item.metadata, label), resource.canonicalMetadata, `${label} canonical custom metadata`);
	assert.equal(storedContent.sha256, resource.canonicalContentSha256, `${label} stored/canonical content SHA`);
	assert.equal(storedContent.byteLength, resource.canonicalContentBytes, `${label} stored/canonical content bytes`);
	assert.equal(item.fileSize, storedContent.byteLength, `${label} item/stored content bytes`);
	const databaseLatestEpochMs =
		Math.max(resource.resourceUpdatedEpochMicros, resource.latestTranslationUpdatedEpochMicros ?? resource.resourceUpdatedEpochMicros) /
		1000;
	assert.ok(databaseLatestEpochMs <= timestampMs(item.lastSeenAt, `${label} last-seen`), `${label} DB state predates stored item`);
}

async function captureTarget(accountId, apiToken, db, listedItem) {
	const listed = normalizeItem(listedItem, `listed ${listedItem.id}`);
	const [item, logs, resource, storedContent] = await Promise.all([
		loadItem(accountId, apiToken, listed.itemId, listed.resourceId),
		loadLogs(accountId, apiToken, listed.itemId, listed.resourceId),
		loadCanonicalResource(db, listed.resourceId),
		downloadItemContent(accountId, apiToken, listed.itemId, listed.resourceId),
	]);
	assert.deepEqual(item, listed, `${listed.resourceId} detail matches terminal listing`);
	assertCanonicalItem(item, resource, storedContent, listed.resourceId);
	return { item, resource, storedContent, baselineLogs: logs };
}

function checkpointDigest(snapshot) {
	const { digest: _digest, ...digestInput } = snapshot;
	return createHash('sha256').update(JSON.stringify(digestInput), 'utf8').digest('hex');
}

async function captureSnapshot(accountId, apiToken, db) {
	await assertGlobalUnresolvedIntents(db);
	const terminalItems = [];
	for (const status of TERMINAL_STATUSES) terminalItems.push(...(await listStatusItems(accountId, apiToken, status)));
	assert.ok(terminalItems.length > 0, 'terminal retry snapshot is non-empty');
	const targets = (await mapSequentially(terminalItems, (item) => captureTarget(accountId, apiToken, db, item))).sort((left, right) =>
		compareAscii(left.item.resourceId, right.item.resourceId),
	);
	assert.equal(new Set(targets.map((target) => target.item.itemId)).size, targets.length, 'checkpoint item IDs are unique');
	assert.equal(new Set(targets.map((target) => target.item.resourceId)).size, targets.length, 'checkpoint resource IDs are unique');
	const snapshot = {
		schemaVersion: 3,
		checkpointRunId: randomUUID(),
		accountId,
		namespace: NAMESPACE,
		aiSearchInstanceName: INDEX_NAME,
		capturedAt: new Date().toISOString(),
		dbFences: await loadDbFences(db),
		instanceFence: await loadInstanceFence(accountId, apiToken),
		stats: await loadStats(accountId, apiToken),
		targets,
	};
	assert.equal(snapshot.stats.error, targets.filter((target) => target.item.status === 'error').length, 'captured error count');
	assert.equal(snapshot.stats.outdated, targets.filter((target) => target.item.status === 'outdated').length, 'captured outdated count');
	assert.equal(snapshot.stats.queued, 0, 'capture queue is empty');
	assert.equal(snapshot.stats.running, 0, 'capture running set is empty');
	assert.equal(snapshot.stats.skipped, 0, 'capture skipped set is empty');
	assert.equal(
		snapshot.stats.completed + targets.length,
		snapshot.dbFences.eligibleCount,
		'completed and approved terminal items account for the frozen eligible corpus',
	);
	return { ...snapshot, digest: checkpointDigest(snapshot) };
}

function snapshotComparable(snapshot) {
	const { checkpointRunId: _checkpointRunId, capturedAt: _capturedAt, digest: _digest, ...comparable } = snapshot;
	return comparable;
}

async function captureStableSnapshot(accountId, apiToken, db) {
	const first = await captureSnapshot(accountId, apiToken, db);
	await sleep(SNAPSHOT_STABILIZATION_MS);
	const second = await captureSnapshot(accountId, apiToken, db);
	assert.deepEqual(snapshotComparable(second), snapshotComparable(first), 'terminal item snapshot remained stable');
	return second;
}

async function loadCheckpoint(path) {
	const checkpoint = JSON.parse(await readFile(path, 'utf8'));
	assert.equal(checkpoint.schemaVersion, 3, 'checkpoint schema version');
	assert.match(checkpoint.checkpointRunId ?? '', UUID, 'checkpoint run ID');
	assert.match(checkpoint.accountId ?? '', /^[0-9a-f]{32}$/, 'checkpoint account ID');
	assert.equal(checkpoint.namespace, NAMESPACE, 'checkpoint namespace');
	assert.equal(checkpoint.aiSearchInstanceName, INDEX_NAME, 'checkpoint AI Search instance');
	assert.ok(Number.isFinite(Date.parse(checkpoint.capturedAt)), 'checkpoint captured timestamp');
	assert.match(checkpoint.digest ?? '', /^[0-9a-f]{64}$/, 'checkpoint digest');
	assert.ok(Array.isArray(checkpoint.targets) && checkpoint.targets.length > 0, 'checkpoint targets');
	assert.equal(checkpointDigest(checkpoint), checkpoint.digest, 'checkpoint digest');
	return checkpoint;
}

async function writeCheckpointArtifact(path, snapshot) {
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
	try {
		await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
		await link(temporaryPath, path);
	} finally {
		await unlink(temporaryPath).catch((error) => {
			if (error?.code !== 'ENOENT') throw error;
		});
	}
}

async function acquireOperatorLock(db) {
	const result = await db.query(`SELECT pg_try_advisory_lock($1, $2) AS acquired`, APPLY_ADVISORY_LOCK);
	assert.equal(result.rows[0]?.acquired, true, '#251 AI Search retry operator lock');
}

async function releaseOperatorLock(db) {
	const result = await db.query(`SELECT pg_advisory_unlock($1, $2) AS released`, APPLY_ADVISORY_LOCK);
	assert.equal(result.rows[0]?.released, true, '#251 AI Search retry operator lock release');
}

function normalizeIntent(row) {
	const attemptedAtEpochMs = Number(row.attempted_at_epoch_ms);
	const dispatchedAtEpochMs = row.dispatched_at_epoch_ms === null ? null : Number(row.dispatched_at_epoch_ms);
	const resolvedAtEpochMs = row.resolved_at_epoch_ms === null ? null : Number(row.resolved_at_epoch_ms);
	assert.match(row.checkpoint_run_id ?? '', UUID, 'retry intent checkpoint ID');
	assert.match(row.checkpoint_digest ?? '', /^[0-9a-f]{64}$/, 'retry intent checkpoint digest');
	assert.match(row.item_id ?? '', ITEM_ID, 'retry intent item ID');
	assert.match(row.resource_id ?? '', UUID, 'retry intent resource ID');
	assert.ok(['prepared', 'dispatched', 'completed', 'failed', 'abandoned'].includes(row.state), 'retry intent state');
	assert.ok(Number.isSafeInteger(attemptedAtEpochMs) && attemptedAtEpochMs > 0, 'retry intent attempted timestamp');
	assert.ok(
		dispatchedAtEpochMs === null || (Number.isSafeInteger(dispatchedAtEpochMs) && dispatchedAtEpochMs >= attemptedAtEpochMs),
		'retry intent dispatched timestamp',
	);
	assert.ok(
		resolvedAtEpochMs === null ||
			(Number.isSafeInteger(resolvedAtEpochMs) && resolvedAtEpochMs >= (dispatchedAtEpochMs ?? attemptedAtEpochMs)),
		'retry intent resolved timestamp',
	);
	if (row.state === 'prepared') {
		assert.equal(dispatchedAtEpochMs, null, 'prepared intent has no dispatch timestamp');
		assert.equal(resolvedAtEpochMs, null, 'prepared intent has no resolution timestamp');
		assert.equal(row.resolution, null, 'prepared intent has no resolution');
	} else if (row.state === 'dispatched') {
		assert.ok(dispatchedAtEpochMs, 'dispatched intent timestamp');
		assert.equal(resolvedAtEpochMs, null, 'dispatched intent has no resolution timestamp');
		assert.equal(row.resolution, null, 'dispatched intent has no resolution');
	} else {
		assert.ok(resolvedAtEpochMs, 'resolved intent timestamp');
		assert.ok(row.resolution && typeof row.resolution === 'object' && !Array.isArray(row.resolution), 'resolved intent evidence');
		assert.equal(row.state === 'abandoned', dispatchedAtEpochMs === null, 'abandoned intent was never dispatched');
		if (row.state !== 'abandoned') assert.ok(dispatchedAtEpochMs, 'completed/failed intent was dispatched');
	}
	return {
		checkpointRunId: row.checkpoint_run_id,
		checkpointDigest: row.checkpoint_digest,
		itemId: row.item_id,
		resourceId: row.resource_id,
		state: row.state,
		attemptedAtEpochMs,
		dispatchedAtEpochMs,
		resolvedAtEpochMs,
		resolution: row.resolution,
	};
}

async function assertGlobalUnresolvedIntents(db, checkpoint = null) {
	const result = await db.query(
		`SELECT checkpoint_run_id::text, checkpoint_digest, item_id, resource_id::text
		   FROM migration_guards.ai_search_retry_intents_251
		  WHERE state IN ('prepared', 'dispatched')
		  ORDER BY checkpoint_run_id, resource_id`,
	);
	if (!checkpoint) {
		assert.equal(result.rowCount, 0, 'no unresolved retry intent exists before checkpoint capture');
		return;
	}
	const targetsByItem = new Map(checkpoint.targets.map((target) => [target.item.itemId, target]));
	for (const row of result.rows) {
		assert.equal(row.checkpoint_run_id, checkpoint.checkpointRunId, `${row.resource_id} unresolved intent checkpoint`);
		assert.equal(row.checkpoint_digest, checkpoint.digest, `${row.resource_id} unresolved intent digest`);
		const target = targetsByItem.get(row.item_id);
		assert.ok(target, `${row.resource_id} unresolved intent belongs to approved targets`);
		assert.equal(row.resource_id, target.item.resourceId, `${row.resource_id} unresolved intent resource`);
	}
}

async function loadCheckpointIntents(db, checkpoint) {
	const result = await db.query(
		`SELECT
		   checkpoint_run_id::text,
		   checkpoint_digest,
		   item_id,
		   resource_id::text,
		   state,
		   round(extract(epoch FROM attempted_at) * 1000)::bigint::text AS attempted_at_epoch_ms,
		   CASE
		     WHEN dispatched_at IS NULL THEN NULL
		     ELSE round(extract(epoch FROM dispatched_at) * 1000)::bigint::text
		   END AS dispatched_at_epoch_ms,
		   CASE
		     WHEN resolved_at IS NULL THEN NULL
		     ELSE round(extract(epoch FROM resolved_at) * 1000)::bigint::text
		   END AS resolved_at_epoch_ms,
		   resolution
		 FROM migration_guards.ai_search_retry_intents_251
		WHERE checkpoint_run_id = $1::uuid
		ORDER BY resource_id`,
		[checkpoint.checkpointRunId],
	);
	const targetsByItem = new Map(checkpoint.targets.map((target) => [target.item.itemId, target]));
	const intents = result.rows.map(normalizeIntent);
	for (const intent of intents) {
		assert.equal(intent.checkpointDigest, checkpoint.digest, `${intent.resourceId} retry intent digest`);
		const target = targetsByItem.get(intent.itemId);
		assert.ok(target, `${intent.resourceId} retry intent belongs to checkpoint`);
		assert.equal(intent.resourceId, target.item.resourceId, `${intent.resourceId} retry intent resource`);
	}
	assert.equal(new Set(intents.map((intent) => intent.itemId)).size, intents.length, 'checkpoint retry intent item IDs');
	await assertGlobalUnresolvedIntents(db, checkpoint);
	return new Map(intents.map((intent) => [intent.itemId, intent]));
}

async function createRetryIntent(db, checkpoint, checkpointTarget) {
	const unresolved = await db.query(
		`SELECT checkpoint_run_id::text, item_id
		   FROM migration_guards.ai_search_retry_intents_251
		  WHERE resource_id = $1::uuid
		    AND state IN ('prepared', 'dispatched')`,
		[checkpointTarget.item.resourceId],
	);
	assert.equal(unresolved.rowCount, 0, `${checkpointTarget.item.resourceId} has no unresolved prior retry intent`);
	const result = await db.query(
		`INSERT INTO migration_guards.ai_search_retry_intents_251 (
		   checkpoint_run_id,
		   checkpoint_digest,
		   item_id,
		   resource_id,
		   state
		 )
		 VALUES ($1::uuid, $2, $3, $4::uuid, 'prepared')
		 RETURNING
		   checkpoint_run_id::text,
		   checkpoint_digest,
		   item_id,
		   resource_id::text,
		   state,
		   round(extract(epoch FROM attempted_at) * 1000)::bigint::text AS attempted_at_epoch_ms,
		   NULL::text AS dispatched_at_epoch_ms,
		   NULL::text AS resolved_at_epoch_ms,
		   resolution`,
		[checkpoint.checkpointRunId, checkpoint.digest, checkpointTarget.item.itemId, checkpointTarget.item.resourceId],
	);
	assert.equal(result.rowCount, 1, `${checkpointTarget.item.resourceId} retry intent committed`);
	return normalizeIntent(result.rows[0]);
}

async function dispatchRetryIntent(db, intent) {
	assert.equal(intent.state, 'prepared', 'only a prepared retry intent can be dispatched');
	const result = await db.query(
		`UPDATE migration_guards.ai_search_retry_intents_251
		    SET state = 'dispatched',
		        dispatched_at = clock_timestamp()
		  WHERE checkpoint_run_id = $1::uuid
		    AND item_id = $2
		    AND state = 'prepared'
		 RETURNING
		   checkpoint_run_id::text,
		   checkpoint_digest,
		   item_id,
		   resource_id::text,
		   state,
		   round(extract(epoch FROM attempted_at) * 1000)::bigint::text AS attempted_at_epoch_ms,
		   round(extract(epoch FROM dispatched_at) * 1000)::bigint::text AS dispatched_at_epoch_ms,
		   NULL::text AS resolved_at_epoch_ms,
		   resolution`,
		[intent.checkpointRunId, intent.itemId],
	);
	assert.equal(result.rowCount, 1, `${intent.resourceId} retry dispatch committed`);
	return normalizeIntent(result.rows[0]);
}

async function abandonPreparedIntent(db, intent) {
	assert.equal(intent.state, 'prepared', 'only a prepared retry intent can be abandoned');
	const result = await db.query(
		`UPDATE migration_guards.ai_search_retry_intents_251
		    SET state = 'abandoned',
		        resolved_at = clock_timestamp(),
		        resolution = $3::jsonb
		  WHERE checkpoint_run_id = $1::uuid
		    AND item_id = $2
		    AND state = 'prepared'
		 RETURNING
		   checkpoint_run_id::text,
		   checkpoint_digest,
		   item_id,
		   resource_id::text,
		   state,
		   round(extract(epoch FROM attempted_at) * 1000)::bigint::text AS attempted_at_epoch_ms,
		   NULL::text AS dispatched_at_epoch_ms,
		   round(extract(epoch FROM resolved_at) * 1000)::bigint::text AS resolved_at_epoch_ms,
		   resolution`,
		[
			intent.checkpointRunId,
			intent.itemId,
			JSON.stringify({
				reason: 'prepared intent recovered before dispatch; no PATCH was authorized by the ledger state',
			}),
		],
	);
	assert.equal(result.rowCount, 1, `${intent.resourceId} prepared retry intent abandoned`);
	return normalizeIntent(result.rows[0]);
}

async function resolveRetryIntent(db, intent, state, resolution) {
	assert.ok(['completed', 'failed'].includes(state), 'retry intent resolution state');
	assert.equal(intent.state, 'dispatched', 'only a dispatched retry intent can resolve');
	const result = await db.query(
		`UPDATE migration_guards.ai_search_retry_intents_251
		    SET state = $3,
		        resolved_at = clock_timestamp(),
		        resolution = $4::jsonb
		  WHERE checkpoint_run_id = $1::uuid
		    AND item_id = $2
		    AND state = 'dispatched'
		 RETURNING
		   checkpoint_run_id::text,
		   checkpoint_digest,
		   item_id,
		   resource_id::text,
		   state,
		   round(extract(epoch FROM attempted_at) * 1000)::bigint::text AS attempted_at_epoch_ms,
		   round(extract(epoch FROM dispatched_at) * 1000)::bigint::text AS dispatched_at_epoch_ms,
		   round(extract(epoch FROM resolved_at) * 1000)::bigint::text AS resolved_at_epoch_ms,
		   resolution`,
		[intent.checkpointRunId, intent.itemId, state, JSON.stringify(resolution)],
	);
	assert.equal(result.rowCount, 1, `${intent.resourceId} retry intent resolved as ${state}`);
	return normalizeIntent(result.rows[0]);
}

function assertItemIdentity(current, checkpointTarget, label) {
	const expected = checkpointTarget.item;
	assert.equal(current.itemId, expected.itemId, `${label} item ID`);
	assert.equal(current.resourceId, expected.resourceId, `${label} resource ID`);
	assert.equal(current.key, expected.key, `${label} key`);
	assert.equal(current.sourceId, expected.sourceId, `${label} source`);
	assert.equal(current.checksum, expected.checksum, `${label} checksum`);
	assert.equal(current.fileSize, expected.fileSize, `${label} file size`);
	assert.equal(current.createdAt, expected.createdAt, `${label} created timestamp`);
	assert.deepEqual(current.metadata, expected.metadata, `${label} metadata`);
}

function newLogs(currentLogs, checkpointTarget) {
	const baseline = new Set(checkpointTarget.baselineLogs.map(logSignature));
	return currentLogs.filter((log) => !baseline.has(logSignature(log)));
}

function successfulReindexLog(logs, checkpointTarget, intent, item) {
	return logs.find(
		(log) =>
			['indexed', 'reindexed'].includes(log.action) &&
			log.fileKey === checkpointTarget.item.key &&
			log.errorType === null &&
			log.errorMessage === null &&
			log.chunkCount === item.chunksCount &&
			timestampMs(log.timestamp, `${item.resourceId} success log`) >= intent.dispatchedAtEpochMs - LOG_CLOCK_SKEW_MS,
	);
}

async function assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents) {
	const [dbFences, instanceFence, stats] = await Promise.all([
		loadDbFences(db),
		loadInstanceFence(accountId, apiToken),
		loadStats(accountId, apiToken),
	]);
	assert.deepEqual(dbFences, checkpoint.dbFences, 'global database/search fences remain frozen');
	assert.deepEqual(instanceFence, checkpoint.instanceFence, 'global AI Search instance fence remains frozen');
	const statusItems = {};
	for (const status of NON_COMPLETED_STATUSES) {
		statusItems[status] = (await listStatusItems(accountId, apiToken, status)).map((item) => normalizeItem(item, `${status} ${item.id}`));
		assert.equal(statusItems[status].length, stats[status], `${status} listing matches stats`);
	}
	assert.deepEqual(statusItems.skipped, [], 'no skipped items during retry');
	const nonCompletedItems = NON_COMPLETED_STATUSES.flatMap((status) => statusItems[status]);
	assert.equal(
		stats.completed + nonCompletedItems.length,
		checkpoint.dbFences.eligibleCount,
		'completed and non-completed items account for the frozen eligible corpus',
	);
	const targetsByItem = new Map(checkpoint.targets.map((target) => [target.item.itemId, target]));
	for (const item of nonCompletedItems) {
		assert.equal(targetsByItem.has(item.itemId), true, `unapproved ${item.status} item ${item.itemId}/${item.key}`);
	}
	const terminalByItem = new Map(TERMINAL_STATUSES.flatMap((status) => statusItems[status]).map((item) => [item.itemId, item]));
	const inProgressItems = IN_PROGRESS_STATUSES.flatMap((status) => statusItems[status]);
	assert.ok(inProgressItems.length <= 1, 'at most one approved item is in progress');
	for (const item of inProgressItems) {
		assert.equal(intents.get(item.itemId)?.state, 'dispatched', `${item.resourceId} in-progress item has a dispatched intent`);
	}
	for (const target of checkpoint.targets) {
		const intent = intents.get(target.item.itemId);
		const terminalItem = terminalByItem.get(target.item.itemId);
		const inProgressItem = inProgressItems.find((item) => item.itemId === target.item.itemId);
		if (!intent) {
			assert.ok(terminalItem, `${target.item.resourceId} unattempted target remains terminal`);
			assert.deepEqual(terminalItem, target.item, `${target.item.resourceId} unattempted target matches checkpoint`);
			continue;
		}
		if (intent.state === 'failed' || intent.state === 'abandoned') {
			assert.fail(`${target.item.resourceId} ${intent.state} under this checkpoint; capture and approve a new checkpoint`);
		}
		if (intent.state === 'completed') {
			assert.equal(terminalItem ?? inProgressItem ?? null, null, `${target.item.resourceId} completed intent is terminal-free`);
			continue;
		}
		assert.ok(['prepared', 'dispatched'].includes(intent.state), `${target.item.resourceId} unresolved intent`);
	}
	return { dbFences, instanceFence, stats, statusItems };
}

async function assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item) {
	const [resource, storedContent] = await Promise.all([
		loadCanonicalResource(db, checkpointTarget.item.resourceId),
		downloadItemContent(accountId, apiToken, checkpointTarget.item.itemId, checkpointTarget.item.resourceId),
	]);
	assert.deepEqual(resource, checkpointTarget.resource, `${checkpointTarget.item.resourceId} canonical DB fence`);
	assert.deepEqual(storedContent, checkpointTarget.storedContent, `${checkpointTarget.item.resourceId} stored content fence`);
	assertCanonicalItem(item, resource, storedContent, checkpointTarget.item.resourceId);
	return { resource, storedContent };
}

async function waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, mutationResult) {
	for (let attempt = 0; attempt < ITEM_POLL_ATTEMPTS; attempt++) {
		const [item, logs] = await Promise.all([
			loadItem(accountId, apiToken, checkpointTarget.item.itemId, checkpointTarget.item.resourceId),
			loadLogs(accountId, apiToken, checkpointTarget.item.itemId, checkpointTarget.item.resourceId),
		]);
		assertItemIdentity(item, checkpointTarget, checkpointTarget.item.resourceId);
		const addedLogs = newLogs(logs, checkpointTarget);
		const successLog = successfulReindexLog(addedLogs, checkpointTarget, intent, item);
		if (item.status === 'completed' && item.error === null && successLog) {
			assert.ok(item.chunksCount > 0, `${item.resourceId} completed chunks`);
			assert.ok(
				timestampMs(item.lastSeenAt, `${item.resourceId} completed last-seen`) >
					timestampMs(checkpointTarget.item.lastSeenAt, `${item.resourceId} checkpoint last-seen`),
				`${item.resourceId} completed item advanced last-seen`,
			);
			await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
			assert.deepEqual(await loadDbFences(db), checkpoint.dbFences, `${item.resourceId} final database/search fences`);
			assert.deepEqual(
				await loadInstanceFence(accountId, apiToken),
				checkpoint.instanceFence,
				`${item.resourceId} final AI Search instance fence`,
			);
			const resolvedIntent =
				intent.state === 'completed'
					? intent
					: await resolveRetryIntent(db, intent, 'completed', {
							chunksCount: item.chunksCount,
							itemLastSeenAt: item.lastSeenAt,
							mutationResult,
							successLog,
						});
			return {
				itemId: item.itemId,
				resourceId: item.resourceId,
				status: item.status,
				chunksCount: item.chunksCount,
				successLog,
				mutationResult,
				intent: resolvedIntent,
			};
		}
		const failedLog = addedLogs.find((log) => log.errorType !== null || ['error', 'outdated', 'skipped'].includes(log.action));
		if (failedLog) {
			if (intent.state === 'dispatched') {
				await resolveRetryIntent(db, intent, 'failed', {
					failedItem: {
						error: item.error,
						lastSeenAt: item.lastSeenAt,
						status: item.status,
					},
					failedLog,
					mutationResult,
				});
			}
			throw new Error(`${item.resourceId} retry produced a terminal log: ${JSON.stringify(failedLog)}`);
		}
		if (attempt < ITEM_POLL_ATTEMPTS - 1) await sleep(ITEM_POLL_INTERVAL_MS);
	}
	throw new Error(`${checkpointTarget.item.resourceId} retry acknowledgement remained ambiguous: ${JSON.stringify(mutationResult)}`);
}

async function reconcileOrRetryTarget(accountId, apiToken, db, checkpoint, checkpointTarget) {
	let intents = await loadCheckpointIntents(db, checkpoint);
	await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents);
	const [item, logs] = await Promise.all([
		loadItem(accountId, apiToken, checkpointTarget.item.itemId, checkpointTarget.item.resourceId),
		loadLogs(accountId, apiToken, checkpointTarget.item.itemId, checkpointTarget.item.resourceId),
	]);
	assertItemIdentity(item, checkpointTarget, checkpointTarget.item.resourceId);
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
	let intent = intents.get(item.itemId) ?? null;
	const addedLogs = newLogs(logs, checkpointTarget);
	if (intent) {
		if (intent.state === 'prepared') {
			intent = await abandonPreparedIntent(db, intent);
			assert.fail(
				`${item.resourceId} recovered a pre-dispatch crash and abandoned the prepared intent; capture and approve a new checkpoint`,
			);
		}
		if (intent.state === 'abandoned' || intent.state === 'failed') {
			assert.fail(`${item.resourceId} ${intent.state} under this checkpoint; capture and approve a new checkpoint`);
		}
		const successLog = successfulReindexLog(addedLogs, checkpointTarget, intent, item);
		if (item.status === 'completed' && item.error === null && successLog) {
			return waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, {
				acknowledged: true,
				ambiguous: false,
				cfRay: null,
				error: null,
				httpStatus: null,
				responseDigest: null,
				result: intent.state === 'completed' ? 'completed-before-resume' : 'completed-after-unresolved-intent',
			});
		}
		if (intent.state === 'completed') {
			assert.fail(`${item.resourceId} completed retry intent no longer has its successful item/log evidence`);
		}
		if (item.status === 'queued' || item.status === 'running') {
			return waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, {
				acknowledged: false,
				ambiguous: true,
				cfRay: null,
				error: 'reconciling an in-progress durable intent',
				httpStatus: null,
				responseDigest: null,
				result: null,
			});
		}
		const failedLog = addedLogs.find((log) => log.errorType !== null || ['error', 'outdated', 'skipped'].includes(log.action));
		if (failedLog) {
			if (intent.state === 'dispatched') {
				intent = await resolveRetryIntent(db, intent, 'failed', {
					failedItem: {
						error: item.error,
						lastSeenAt: item.lastSeenAt,
						status: item.status,
					},
					failedLog,
					mutationResult: null,
				});
			}
			assert.fail(`${item.resourceId} prior retry failed under this checkpoint: ${JSON.stringify(intent.resolution)}`);
		}
		assert.fail(
			`${item.resourceId} has a durable mutation intent but no observable advancement; approve a new checkpoint only after reconciliation`,
		);
	}
	assert.deepEqual(item, checkpointTarget.item, `${item.resourceId} terminal item matches checkpoint immediately before PATCH`);
	assert.deepEqual(logs, checkpointTarget.baselineLogs, `${item.resourceId} logs match checkpoint immediately before PATCH`);
	intent = await createRetryIntent(db, checkpoint, checkpointTarget);
	intents = await loadCheckpointIntents(db, checkpoint);
	assert.deepEqual(intents.get(item.itemId), intent, `${item.resourceId} durable intent read-after-write`);
	await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents);
	const [mutationItem, mutationLogs] = await Promise.all([
		loadItem(accountId, apiToken, checkpointTarget.item.itemId, `${checkpointTarget.item.resourceId} post-intent`),
		loadLogs(accountId, apiToken, checkpointTarget.item.itemId, `${checkpointTarget.item.resourceId} post-intent`),
	]);
	assert.deepEqual(mutationItem, checkpointTarget.item, `${item.resourceId} item remains pinned after intent commit`);
	assert.deepEqual(mutationLogs, checkpointTarget.baselineLogs, `${item.resourceId} logs remain pinned after intent commit`);
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, mutationItem);
	intent = await dispatchRetryIntent(db, intent);
	const mutationResult = await syncMutation(accountId, apiToken, checkpointTarget);
	return waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, mutationResult);
}

async function captureFinalTarget(accountId, apiToken, db, checkpointTarget, intent) {
	assert.equal(intent?.state, 'completed', `${checkpointTarget.item.resourceId} retry intent completed`);
	const [item, logs] = await Promise.all([
		loadItem(accountId, apiToken, checkpointTarget.item.itemId, `${checkpointTarget.item.resourceId} final`),
		loadLogs(accountId, apiToken, checkpointTarget.item.itemId, `${checkpointTarget.item.resourceId} final`),
	]);
	assertItemIdentity(item, checkpointTarget, checkpointTarget.item.resourceId);
	assert.equal(item.status, 'completed', `${item.resourceId} final item status`);
	assert.equal(item.error, null, `${item.resourceId} final item error`);
	assert.ok(item.chunksCount > 0, `${item.resourceId} final chunks`);
	const addedLogs = newLogs(logs, checkpointTarget);
	const successLog = successfulReindexLog(addedLogs, checkpointTarget, intent, item);
	assert.ok(successLog, `${item.resourceId} final successful retry log`);
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
	return { intent, item, successLog };
}

async function captureFinalState(accountId, apiToken, db, checkpoint) {
	const intents = await loadCheckpointIntents(db, checkpoint);
	assert.equal(intents.size, checkpoint.targets.length, 'every checkpoint target has a retry intent');
	const global = await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents);
	for (const status of NON_COMPLETED_STATUSES) assert.equal(global.stats[status], 0, `final ${status} items`);
	assert.equal(global.stats.completed, checkpoint.dbFences.eligibleCount, 'completed items match frozen eligible corpus');
	const targets = await mapSequentially(checkpoint.targets, (target) =>
		captureFinalTarget(accountId, apiToken, db, target, intents.get(target.item.itemId)),
	);
	return {
		dbFences: global.dbFences,
		instanceFence: global.instanceFence,
		stats: global.stats,
		targets,
	};
}

async function assertFinalState(accountId, apiToken, db, checkpoint) {
	const first = await captureFinalState(accountId, apiToken, db, checkpoint);
	await sleep(SNAPSHOT_STABILIZATION_MS);
	const second = await captureFinalState(accountId, apiToken, db, checkpoint);
	assert.deepEqual(second, first, 'final retry state remained stable');
	return second;
}

function sleep(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const { accountId, apiToken } = credentials();
const db = new pg.Client({ connectionString: databaseUrl() });
await db.connect();
let operatorLockHeld = false;
try {
	await db.query(`SET TIME ZONE 'UTC'`);
	await db.query(`SET search_path = pg_catalog, public`);
	await acquireOperatorLock(db);
	operatorLockHeld = true;
	if (capture) {
		const snapshot = await captureStableSnapshot(accountId, apiToken, db);
		await writeCheckpointArtifact(outputPath, snapshot);
		process.stdout.write(
			`${JSON.stringify({
				event: 'search_outdated_retry_251_checkpoint_captured',
				outputPath,
				checkpointRunId: snapshot.checkpointRunId,
				capturedAt: snapshot.capturedAt,
				digest: snapshot.digest,
				targetCount: snapshot.targets.length,
			})}\n`,
		);
	} else {
		const checkpoint = await loadCheckpoint(checkpointPath);
		assert.equal(checkpoint.accountId, accountId, 'checkpoint Cloudflare account');
		assert.equal(approvalDigest, checkpoint.digest, 'operator approval digest matches checkpoint');
		assert.deepEqual(await loadDbFences(db), checkpoint.dbFences, 'checkpoint database/search fences');
		assert.deepEqual(await loadInstanceFence(accountId, apiToken), checkpoint.instanceFence, 'checkpoint instance fence');
		const results = [];
		for (const [index, target] of checkpoint.targets.entries()) {
			const result = await reconcileOrRetryTarget(accountId, apiToken, db, checkpoint, target);
			results.push(result);
			process.stdout.write(
				`${JSON.stringify({
					event: 'search_outdated_retry_251_item_completed',
					completed: index + 1,
					total: checkpoint.targets.length,
					resourceId: result.resourceId,
					itemId: result.itemId,
					status: result.status,
				})}\n`,
			);
		}
		const finalState = await assertFinalState(accountId, apiToken, db, checkpoint);
		process.stdout.write(
			`${JSON.stringify(
				{
					event: 'search_outdated_retry_251_completed',
					checkpoint: {
						checkpointRunId: checkpoint.checkpointRunId,
						capturedAt: checkpoint.capturedAt,
						digest: checkpoint.digest,
						targetCount: checkpoint.targets.length,
					},
					completedAt: new Date().toISOString(),
					results,
					finalState,
				},
				null,
				2,
			)}\n`,
		);
	}
} finally {
	try {
		if (operatorLockHeld) await releaseOperatorLock(db);
	} finally {
		await db.end();
	}
}
