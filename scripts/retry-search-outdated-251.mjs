import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import pg from 'pg';

const NAMESPACE = 'default';
const INDEX_NAME = 'newsence-corpus-v6';
const STATE_INDEX_NAME = 'public-corpus-v6';
const EXPECTED_DATABASE_HOST = 'ap-southeast-2.pg.psdb.cloud';
const EXPECTED_DATABASE_USERNAME_SHA256 = '69684bcea6431899cf8979f79065b86b58279062cc212f4755e34b9200313a54';
const EXPECTED_DATABASE_QUERY = [
	['connect_timeout', '10'],
	['sslmode', 'verify-full'],
	['sslrootcert', 'system'],
];
const ITEM_EVIDENCE_FIELDS = [
	'itemId',
	'resourceId',
	'key',
	'sourceId',
	'status',
	'error',
	'nextAction',
	'checksum',
	'chunksCount',
	'fileSize',
	'createdAt',
	'lastSeenAt',
	'metadata',
];
const LOG_EVIDENCE_FIELDS = ['timestamp', 'action', 'message', 'fileKey', 'chunkCount', 'processingTimeMs', 'errorType', 'errorMessage'];
const GENERATION = 4;
const GENERATION_KEY = 'canonical-4-kind-platform';
const ITEM_PREFIX = 'resources/';
const ITEM_SUFFIX = '.md';
const NULL_RESOURCE_PLATFORM_METADATA = 'none';
const TERMINAL_STATUSES = ['error', 'outdated', 'skipped'];
const IN_PROGRESS_STATUSES = ['queued', 'running'];
const NON_COMPLETED_STATUSES = [...IN_PROGRESS_STATUSES, ...TERMINAL_STATUSES];
const ITEM_STATUSES = ['queued', 'running', 'completed', 'error', 'skipped', 'outdated'];
const PER_PAGE = 50;
const LOG_PAGE_SIZE = 100;
const SNAPSHOT_STABILIZATION_MS = 2_000;
const ITEM_POLL_INTERVAL_MS = 2_000;
const ITEM_POLL_ATTEMPTS = 90;
const MUTATION_TIMEOUT_MS = 60_000;
const NO_EFFECT_MINIMUM_DISPATCH_AGE_MS = 15 * 60 * 1_000;
const NO_EFFECT_STABILIZATION_MS = 60_000;
const LEGACY_NO_EFFECT_APPROVAL = 'provider-sync-null-no-observable-effect-251';
const KEY_REINDEX_NO_EFFECT_APPROVAL = 'provider-key-reindex-no-observable-effect-251';
const RESPONSE_EVIDENCE_UNAVAILABLE = 'pre-response-evidence-unavailable-251';
const MUTATION_METHOD = 'canonical-reindex-by-key-v1';
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
const reconcileNoEffect = argumentsList.includes('--reconcile-no-effect');
assert.equal(
	[capture, apply, reconcileNoEffect].filter(Boolean).length,
	1,
	'Select exactly one mode: --capture, --apply, or --reconcile-no-effect',
);
const checkpointArguments = argumentsList.filter((argument) => argument.startsWith('--checkpoint='));
const approvalArguments = argumentsList.filter((argument) => argument.startsWith('--approval-digest='));
const outputArguments = argumentsList.filter((argument) => argument.startsWith('--output='));
const itemIdArguments = argumentsList.filter((argument) => argument.startsWith('--item-id='));
const responseDigestArguments = argumentsList.filter((argument) => argument.startsWith('--mutation-response-digest='));
const cfRayArguments = argumentsList.filter((argument) => argument.startsWith('--mutation-cf-ray='));
const noEffectApprovalArguments = argumentsList.filter((argument) => argument.startsWith('--no-effect-approval='));
const unavailableEvidenceArguments = argumentsList.filter((argument) => argument.startsWith('--response-evidence-unavailable='));
assert.ok(checkpointArguments.length <= 1, 'checkpoint argument is unique');
assert.ok(approvalArguments.length <= 1, 'approval digest argument is unique');
assert.ok(outputArguments.length <= 1, 'output argument is unique');
assert.ok(itemIdArguments.length <= 1, 'item ID argument is unique');
assert.ok(responseDigestArguments.length <= 1, 'mutation response digest argument is unique');
assert.ok(cfRayArguments.length <= 1, 'mutation CF-Ray argument is unique');
assert.ok(noEffectApprovalArguments.length <= 1, 'no-effect approval argument is unique');
assert.ok(unavailableEvidenceArguments.length <= 1, 'unavailable response-evidence argument is unique');
const checkpointPath = checkpointArguments[0]?.slice('--checkpoint='.length) ?? null;
const approvalDigest = approvalArguments[0]?.slice('--approval-digest='.length) ?? null;
const outputPath = outputArguments[0]?.slice('--output='.length) ?? null;
const reconciliationItemId = itemIdArguments[0]?.slice('--item-id='.length) ?? null;
const mutationResponseDigest = responseDigestArguments[0]?.slice('--mutation-response-digest='.length) ?? null;
const mutationCfRay = cfRayArguments[0]?.slice('--mutation-cf-ray='.length) ?? null;
const noEffectApproval = noEffectApprovalArguments[0]?.slice('--no-effect-approval='.length) ?? null;
const unavailableResponseEvidence = unavailableEvidenceArguments[0]?.slice('--response-evidence-unavailable='.length) ?? null;
assert.deepEqual(
	argumentsList.filter(
		(argument) =>
			!['--capture', '--apply', '--reconcile-no-effect'].includes(argument) &&
			!argument.startsWith('--checkpoint=') &&
			!argument.startsWith('--approval-digest=') &&
			!argument.startsWith('--output=') &&
			!argument.startsWith('--item-id=') &&
			!argument.startsWith('--mutation-response-digest=') &&
			!argument.startsWith('--mutation-cf-ray=') &&
			!argument.startsWith('--no-effect-approval=') &&
			!argument.startsWith('--response-evidence-unavailable='),
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
	assert.equal(reconciliationItemId, null, 'capture does not accept an item ID');
	assert.equal(mutationResponseDigest, null, 'capture does not accept mutation response evidence');
	assert.equal(mutationCfRay, null, 'capture does not accept mutation CF-Ray evidence');
	assert.equal(noEffectApproval, null, 'capture does not accept no-effect approval');
	assert.equal(unavailableResponseEvidence, null, 'capture does not accept unavailable response evidence');
} else if (apply) {
	assert.ok(checkpointPath, 'apply requires --checkpoint=<path>');
	assert.equal(outputPath, null, 'apply does not accept an output path');
	assert.match(approvalDigest ?? '', /^[0-9a-f]{64}$/, 'apply requires --approval-digest=<sha256>');
	assert.equal(reconciliationItemId, null, 'apply does not accept an item ID');
	assert.equal(mutationResponseDigest, null, 'apply does not accept mutation response evidence');
	assert.equal(mutationCfRay, null, 'apply does not accept mutation CF-Ray evidence');
	assert.equal(noEffectApproval, null, 'apply does not accept no-effect approval');
	assert.equal(unavailableResponseEvidence, null, 'apply does not accept unavailable response evidence');
} else {
	assert.ok(checkpointPath, 'reconciliation requires --checkpoint=<path>');
	assert.equal(outputPath, null, 'reconciliation does not accept an output path');
	assert.match(approvalDigest ?? '', /^[0-9a-f]{64}$/, 'reconciliation requires --approval-digest=<sha256>');
	assert.match(reconciliationItemId ?? '', ITEM_ID, 'reconciliation requires --item-id=<item-id>');
	if (mutationResponseDigest !== null) {
		assert.match(mutationResponseDigest, /^[0-9a-f]{64}$/, 'mutation response digest is a SHA-256');
	}
	if (mutationCfRay !== null) assert.match(mutationCfRay, /^[0-9a-f]+-[A-Z]{3}$/, 'mutation CF-Ray is valid');
	assert.equal(mutationResponseDigest === null, mutationCfRay === null, 'mutation response digest and CF-Ray must be supplied together');
	if (mutationResponseDigest === null) {
		assert.equal(
			unavailableResponseEvidence,
			RESPONSE_EVIDENCE_UNAVAILABLE,
			`missing response evidence requires --response-evidence-unavailable=${RESPONSE_EVIDENCE_UNAVAILABLE}`,
		);
	} else {
		assert.equal(unavailableResponseEvidence, null, 'available response evidence forbids unavailable-evidence acknowledgement');
	}
	assert.ok(
		[LEGACY_NO_EFFECT_APPROVAL, KEY_REINDEX_NO_EFFECT_APPROVAL].includes(noEffectApproval),
		'reconciliation requires an exact no-effect approval',
	);
}

function credentials() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const apiToken = process.env.CLOUDFLARE_AISEARCH_API_TOKEN?.trim();
	assert.match(accountId ?? '', /^[0-9a-f]{32}$/, 'Set CLOUDFLARE_ACCOUNT_ID');
	assert.ok(apiToken, 'Set CLOUDFLARE_AISEARCH_API_TOKEN with AI Search Edit and Run');
	return { accountId, apiToken };
}

function databaseUrl() {
	assert.deepEqual(
		Object.keys(process.env)
			.filter((name) => name.startsWith('PG'))
			.sort(compareAscii),
		[],
		'Operator script rejects ambient PG* connection configuration',
	);
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
	assert.ok(value, 'Set the canonical production Hyperdrive local PostgreSQL connection string');
	let url;
	try {
		url = new URL(value);
	} catch {
		assert.fail('Canonical production PostgreSQL connection string is not a valid URL');
	}
	assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL connection string protocol');
	assert.equal(url.hostname, EXPECTED_DATABASE_HOST, 'Operator script only accepts the reviewed PlanetScale production host');
	const username = decodeURIComponent(url.username);
	assert.ok(username, 'Operator script requires the canonical PlanetScale username');
	assert.equal(sha256(username), EXPECTED_DATABASE_USERNAME_SHA256, 'Operator script requires the reviewed production branch identity');
	assert.ok(url.password, 'Operator script requires the canonical PlanetScale password');
	assert.equal(decodeURIComponent(url.pathname), '/postgres', 'Operator script requires the reviewed production database');
	assert.ok(!username.includes('|'), 'Operator script rejects PlanetScale username routing suffixes');
	assert.deepEqual(
		[...url.searchParams.entries()].sort(([left], [right]) => compareAscii(left, right)),
		EXPECTED_DATABASE_QUERY,
		'Operator script only accepts the reviewed non-routing PostgreSQL query parameters',
	);
	if (url.port === '6432') url.port = '5432';
	assert.equal(url.port, '5432', 'Operator script requires the reviewed PlanetScale direct port 5432; pooled connections are unsafe');
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	url.searchParams.set('application_name', 'newsence-cutover-251-search-retry');
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

function orderedEvidenceObject(value, fields, label) {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} object`);
	assert.deepEqual(Object.keys(value).sort(compareAscii), [...fields].sort(compareAscii), `${label} exact fields`);
	return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function itemEvidenceDigest(item) {
	const ordered = orderedEvidenceObject(item, ITEM_EVIDENCE_FIELDS, 'item evidence digest');
	assert.ok(ordered.metadata && typeof ordered.metadata === 'object' && !Array.isArray(ordered.metadata), 'item evidence metadata');
	ordered.metadata = Object.fromEntries(Object.entries(ordered.metadata).sort(([left], [right]) => compareAscii(left, right)));
	return sha256(JSON.stringify(ordered));
}

function logsEvidenceDigest(logs) {
	assert.ok(Array.isArray(logs), 'logs evidence digest');
	return sha256(JSON.stringify(logs.map((log, index) => orderedEvidenceObject(log, LOG_EVIDENCE_FIELDS, `log evidence digest ${index}`))));
}

function mutationResultError(result, target) {
	if (!result || typeof result !== 'object') return 'successful response contained no item result';
	if (!ITEM_ID.test(result.id ?? '')) return 'response contained an invalid item ID';
	if (result.key !== target.item.key) return 'response contained the wrong item key';
	if (result.source_id !== 'builtin') return 'response contained the wrong item source';
	if (!ITEM_STATUSES.includes(result.status)) return 'response contained an invalid item status';
	return null;
}

async function reindexByKeyMutation(accountId, apiToken, target) {
	try {
		const response = await fetch(itemsUrl(accountId), {
			body: JSON.stringify({
				key: target.item.key,
				next_action: 'INDEX',
				wait_for_completion: false,
			}),
			headers: {
				Authorization: `Bearer ${apiToken}`,
				'Content-Type': 'application/json',
			},
			method: 'PUT',
			signal: AbortSignal.timeout(MUTATION_TIMEOUT_MS),
		});
		const responseText = await response.text();
		let payload = null;
		try {
			payload = JSON.parse(responseText);
		} catch {
			// A delivered mutation with an unparseable response is ambiguous.
		}
		const result = payload?.result;
		const resultError = mutationResultError(result, target);
		const acknowledged = response.ok && payload?.success === true && resultError === null;
		return {
			method: MUTATION_METHOD,
			acknowledged,
			ambiguous: !acknowledged,
			cfRay: response.headers.get('cf-ray'),
			error: response.ok && payload?.success === true ? resultError : `HTTP ${response.status}: ${JSON.stringify(payload?.errors ?? [])}`,
			httpStatus: response.status,
			responseDigest: sha256(responseText),
			result:
				result && typeof result === 'object'
					? {
							id: result.id ?? null,
							key: result.key ?? null,
							sourceId: result.source_id ?? null,
							status: result.status ?? null,
						}
					: null,
		};
	} catch (error) {
		return {
			method: MUTATION_METHOD,
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
	assert.ok(ITEM_STATUSES.includes(item.status), `${label} status`);
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

async function listOwnedItemsByKey(accountId, apiToken, key, label) {
	const url = new URL(itemsUrl(accountId));
	url.searchParams.set('key', key);
	url.searchParams.set('per_page', '2');
	url.searchParams.set('source', 'builtin');
	const payload = await cloudflareGet(url, apiToken, `${label} item by key`);
	assert.ok(Array.isArray(payload.result), `${label} item-by-key result`);
	assert.ok(
		Number.isSafeInteger(payload.result_info?.total_count) && payload.result_info.total_count >= 0,
		`${label} item-by-key total count`,
	);
	assert.equal(payload.result.length, payload.result_info.total_count, `${label} complete item-by-key result`);
	const items = payload.result.map((item) => normalizeItem(item, label));
	assert.ok(items.length <= 1, `${label} has at most one built-in item for ${key}`);
	for (const item of items) assert.equal(item.key, key, `${label} item-by-key exact key`);
	return items;
}

async function loadOwnedItemByKey(accountId, apiToken, key, label) {
	const items = await listOwnedItemsByKey(accountId, apiToken, key, label);
	assert.equal(items.length, 1, `${label} has exactly one built-in item for ${key}`);
	return items[0];
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

async function loadInstanceLastActivity(accountId, apiToken) {
	const instance = (await cloudflareGet(instanceUrl(accountId), apiToken, 'AI Search instance activity')).result;
	assert.equal(instance?.id, INDEX_NAME, 'AI Search instance activity ID');
	assert.equal(typeof instance?.last_activity, 'string', 'AI Search instance last activity');
	assert.ok(Number.isFinite(Date.parse(instance.last_activity)), 'AI Search instance last activity timestamp');
	return instance.last_activity;
}

async function loadDatabaseClock(db, label) {
	const result = await db.query(`SELECT clock_timestamp()::text AS observed_at`);
	assert.equal(result.rowCount, 1, `${label} database clock row`);
	assert.ok(Number.isFinite(Date.parse(result.rows[0].observed_at)), `${label} database clock timestamp`);
	return result.rows[0].observed_at;
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
		schemaVersion: 4,
		mutationMethod: MUTATION_METHOD,
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
	for (const status of TERMINAL_STATUSES) {
		assert.equal(snapshot.stats[status], targets.filter((target) => target.item.status === status).length, `captured ${status} count`);
	}
	assert.equal(snapshot.stats.queued, 0, 'capture queue is empty');
	assert.equal(snapshot.stats.running, 0, 'capture running set is empty');
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
	assert.ok([3, 4].includes(checkpoint.schemaVersion), 'checkpoint schema version');
	if (checkpoint.schemaVersion === 4) assert.equal(checkpoint.mutationMethod, MUTATION_METHOD, 'checkpoint mutation method');
	else assert.equal(checkpoint.mutationMethod, undefined, 'legacy checkpoint has no mutation method');
	assert.match(checkpoint.checkpointRunId ?? '', UUID, 'checkpoint run ID');
	assert.match(checkpoint.accountId ?? '', /^[0-9a-f]{32}$/, 'checkpoint account ID');
	assert.equal(checkpoint.namespace, NAMESPACE, 'checkpoint namespace');
	assert.equal(checkpoint.aiSearchInstanceName, INDEX_NAME, 'checkpoint AI Search instance');
	assert.ok(Number.isFinite(Date.parse(checkpoint.capturedAt)), 'checkpoint captured timestamp');
	assert.match(checkpoint.digest ?? '', /^[0-9a-f]{64}$/, 'checkpoint digest');
	assert.ok(Array.isArray(checkpoint.targets) && checkpoint.targets.length > 0, 'checkpoint targets');
	assert.equal(
		new Set(checkpoint.targets.map((target) => target.item?.itemId)).size,
		checkpoint.targets.length,
		'checkpoint target item IDs are unique',
	);
	assert.equal(
		new Set(checkpoint.targets.map((target) => target.item?.resourceId)).size,
		checkpoint.targets.length,
		'checkpoint target resource IDs are unique',
	);
	assert.equal(
		new Set(checkpoint.targets.map((target) => target.item?.key)).size,
		checkpoint.targets.length,
		'checkpoint target keys are unique',
	);
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
	const result = await db.query(
		`SELECT
		   pg_backend_pid() AS backend_pid,
		   pg_is_in_recovery() AS in_recovery,
		   inet_server_port() AS server_port,
		   CASE
		     WHEN NOT pg_is_in_recovery() AND inet_server_port() = 5432
		     THEN pg_try_advisory_lock($1, $2)
		     ELSE false
		   END AS acquired`,
		APPLY_ADVISORY_LOCK,
	);
	assert.equal(result.rows[0]?.in_recovery, false, '#251 operator database is the primary');
	assert.equal(result.rows[0]?.server_port, 5432, '#251 operator database is direct PostgreSQL port 5432');
	assert.equal(result.rows[0]?.acquired, true, '#251 AI Search retry operator lock');
	assert.ok(Number.isSafeInteger(result.rows[0]?.backend_pid) && result.rows[0].backend_pid > 0, '#251 operator-lock backend PID');
	return result.rows[0].backend_pid;
}

async function releaseOperatorLock(db, expectedBackendPid) {
	const result = await db.query(
		`SELECT
		   pg_backend_pid() AS backend_pid,
		   pg_advisory_unlock($1, $2) AS released`,
		APPLY_ADVISORY_LOCK,
	);
	assert.equal(result.rows[0]?.backend_pid, expectedBackendPid, '#251 operator-lock backend remained pinned');
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
				reason: 'prepared intent recovered before dispatch; no remote mutation was authorized by the ledger state',
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

async function adoptLateCompletionIntent(db, intent, resolution) {
	assert.equal(intent.state, 'failed', 'only a failed retry intent can adopt a late completion');
	assert.ok(isObservedNoEffectFailure(intent), 'only an observed no-effect failure can adopt a late completion');
	const result = await db.query(
		`WITH adoption_clock AS (
		   SELECT clock_timestamp() AS adopted_at
		 )
		 UPDATE migration_guards.ai_search_retry_intents_251 intent
		    SET state = 'completed',
		        resolved_at = adoption_clock.adopted_at,
		        resolution = jsonb_set(
		          $4::jsonb,
		          '{lateCompletionAdoption,adoptedAt}',
		          to_jsonb(adoption_clock.adopted_at::text),
		          true
		        )
		   FROM adoption_clock
		  WHERE intent.checkpoint_run_id = $1::uuid
		    AND intent.item_id = $2
		    AND intent.state = 'failed'
		    AND intent.resolution = $3::jsonb
		    AND NOT EXISTS (
		      SELECT 1
		      FROM migration_guards.ai_search_retry_intents_251 newer
		      WHERE newer.resource_id = intent.resource_id
		        AND newer.attempted_at > intent.resolved_at
		    )
		 RETURNING
		   intent.checkpoint_run_id::text,
		   intent.checkpoint_digest,
		   intent.item_id,
		   intent.resource_id::text,
		   intent.state,
		   round(extract(epoch FROM intent.attempted_at) * 1000)::bigint::text AS attempted_at_epoch_ms,
		   round(extract(epoch FROM intent.dispatched_at) * 1000)::bigint::text AS dispatched_at_epoch_ms,
		   round(extract(epoch FROM intent.resolved_at) * 1000)::bigint::text AS resolved_at_epoch_ms,
		   intent.resolution`,
		[intent.checkpointRunId, intent.itemId, JSON.stringify(intent.resolution), JSON.stringify(resolution)],
	);
	assert.equal(result.rowCount, 1, `${intent.resourceId} late completion adopted with compare-and-swap`);
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

function newLogs(currentLogs, checkpointTarget, currentItemId) {
	if (currentItemId !== checkpointTarget.item.itemId) return currentLogs;
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

function successfulExternalReindexLog(logs, checkpoint, checkpointTarget, item) {
	const minimumTimestamp =
		Math.max(
			timestampMs(checkpoint.capturedAt, `${item.resourceId} checkpoint capture`),
			timestampMs(checkpointTarget.item.lastSeenAt, `${item.resourceId} checkpoint last-seen`),
		) - LOG_CLOCK_SKEW_MS;
	return logs.find(
		(log) =>
			['indexed', 'reindexed'].includes(log.action) &&
			log.fileKey === checkpointTarget.item.key &&
			log.errorType === null &&
			log.errorMessage === null &&
			log.chunkCount === item.chunksCount &&
			timestampMs(log.timestamp, `${item.resourceId} external success log`) >= minimumTimestamp,
	);
}

function failedReindexLog(logs, checkpointTarget, intent, item) {
	return logs.find(
		(log) =>
			log.fileKey === checkpointTarget.item.key &&
			(log.errorType !== null || ['error', 'outdated', 'skipped'].includes(log.action)) &&
			timestampMs(log.timestamp, `${item.resourceId} failure log`) >= intent.dispatchedAtEpochMs - LOG_CLOCK_SKEW_MS,
	);
}

function completedResolution(checkpoint, checkpointTarget, intent, item, successLog, mutationResult, lateCompletionAdoption = null) {
	const resolution = {
		kind: 'canonical_key_reindex_completed',
		checkpointSchemaVersion: checkpoint.schemaVersion,
		mutationMethod: MUTATION_METHOD,
		resourceId: item.resourceId,
		resourceKey: item.key,
		sourceId: item.sourceId,
		previousItemId: checkpointTarget.item.itemId,
		completedItemId: item.itemId,
		canonicalContentSha256: checkpointTarget.resource.canonicalContentSha256,
		canonicalContentBytes: checkpointTarget.resource.canonicalContentBytes,
		chunksCount: item.chunksCount,
		itemLastSeenAt: item.lastSeenAt,
		intentDispatchedAtEpochMs: intent.dispatchedAtEpochMs,
		successLog,
		mutationResult,
	};
	if (lateCompletionAdoption !== null) resolution.lateCompletionAdoption = lateCompletionAdoption;
	return resolution;
}

function legacyPatchLateCompletionResolution(checkpoint, checkpointTarget, intent, item, successLog) {
	return {
		kind: 'legacy_item_patch_late_completion_adopted',
		checkpointSchemaVersion: checkpoint.schemaVersion,
		mutationMethod: 'legacy-item-patch-sync-v1',
		resourceId: item.resourceId,
		resourceKey: item.key,
		sourceId: item.sourceId,
		itemId: item.itemId,
		canonicalContentSha256: checkpointTarget.resource.canonicalContentSha256,
		canonicalContentBytes: checkpointTarget.resource.canonicalContentBytes,
		chunksCount: item.chunksCount,
		itemLastSeenAt: item.lastSeenAt,
		intentDispatchedAtEpochMs: intent.dispatchedAtEpochMs,
		successLog,
		mutationResult: {
			method: 'PATCH item sync with wait_for_completion=true',
			recovery: 'legacy-late-completion-adopted-without-redispatch',
			originalMutationEvidence: intent.resolution.mutationEvidence,
			result: {
				id: item.itemId,
				key: item.key,
				sourceId: item.sourceId,
				status: item.status,
			},
		},
		lateCompletionAdoption: {
			previousResolvedAtEpochMs: intent.resolvedAtEpochMs,
			previousResolution: intent.resolution,
		},
	};
}

function failedResolution(checkpoint, checkpointTarget, intent, item, failedLog, mutationResult) {
	return {
		kind: 'canonical_key_reindex_failed',
		checkpointSchemaVersion: checkpoint.schemaVersion,
		mutationMethod: MUTATION_METHOD,
		resourceId: item.resourceId,
		resourceKey: item.key,
		sourceId: item.sourceId,
		previousItemId: checkpointTarget.item.itemId,
		failedItemId: item.itemId,
		canonicalContentSha256: checkpointTarget.resource.canonicalContentSha256,
		canonicalContentBytes: checkpointTarget.resource.canonicalContentBytes,
		failedItem: {
			error: item.error,
			lastSeenAt: item.lastSeenAt,
			status: item.status,
		},
		intentDispatchedAtEpochMs: intent.dispatchedAtEpochMs,
		failedLog,
		mutationResult,
	};
}

function assertCompletedIntentEvidence(intent, checkpointTarget, item, successLog) {
	const resolution = intent.resolution;
	assert.equal(resolution?.kind, 'canonical_key_reindex_completed', `${item.resourceId} completed intent kind`);
	assert.equal(resolution?.checkpointSchemaVersion, 4, `${item.resourceId} completed intent checkpoint schema`);
	assert.equal(resolution?.mutationMethod, MUTATION_METHOD, `${item.resourceId} completed intent mutation method`);
	assert.equal(resolution?.resourceId, item.resourceId, `${item.resourceId} completed intent resource`);
	assert.equal(resolution?.resourceKey, item.key, `${item.resourceId} completed intent key`);
	assert.equal(resolution?.sourceId, item.sourceId, `${item.resourceId} completed intent source`);
	assert.equal(resolution?.previousItemId, checkpointTarget.item.itemId, `${item.resourceId} completed intent prior item`);
	assert.equal(resolution?.completedItemId, item.itemId, `${item.resourceId} completed intent observed item`);
	assert.equal(
		resolution?.canonicalContentSha256,
		checkpointTarget.resource.canonicalContentSha256,
		`${item.resourceId} completed intent content SHA`,
	);
	assert.equal(
		resolution?.canonicalContentBytes,
		checkpointTarget.resource.canonicalContentBytes,
		`${item.resourceId} completed intent content bytes`,
	);
	assert.equal(resolution?.chunksCount, item.chunksCount, `${item.resourceId} completed intent chunks`);
	assert.equal(resolution?.itemLastSeenAt, item.lastSeenAt, `${item.resourceId} completed intent last-seen`);
	assert.equal(resolution?.intentDispatchedAtEpochMs, intent.dispatchedAtEpochMs, `${item.resourceId} completed intent dispatch`);
	assert.deepEqual(resolution?.successLog, successLog, `${item.resourceId} completed intent success log`);
	if (resolution?.lateCompletionAdoption !== undefined) {
		const adoption = resolution.lateCompletionAdoption;
		assert.equal(
			resolution.mutationResult?.recovery,
			'late-completion-adopted-without-redispatch',
			`${item.resourceId} late completion recovery method`,
		);
		assertNoAdvancementIntentEvidence(previousFailedIntentFromAdoption(intent, adoption, item.resourceId), checkpointTarget);
	}
}

function assertNoAdvancementObservation(observation, checkpointTarget, intent, label) {
	assert.ok(observation && typeof observation === 'object' && !Array.isArray(observation), `${label} observation`);
	const observedAtEpochMs = timestampMs(observation.observedAt, `${label} observed timestamp`);
	const item = observation.item;
	assert.ok(item && typeof item === 'object' && !Array.isArray(item), `${label} observed item`);
	assert.equal(item.resourceId, checkpointTarget.item.resourceId, `${label} observed resource`);
	assert.equal(item.key, checkpointTarget.item.key, `${label} observed key`);
	assert.equal(item.sourceId, 'builtin', `${label} observed source`);
	assert.ok(TERMINAL_STATUSES.includes(item.status), `${label} observed terminal status`);
	assert.deepEqual(
		itemCustomMetadata(item.metadata, item.resourceId),
		checkpointTarget.resource.canonicalMetadata,
		`${label} observed canonical metadata`,
	);
	assert.deepEqual(observation.terminalListingItem, item, `${label} by-key and terminal-listing item agree`);
	assert.equal(observation.itemDigest, itemEvidenceDigest(item), `${label} observed item digest`);
	assert.ok(Array.isArray(observation.logs), `${label} observed logs`);
	assert.equal(observation.logCount, observation.logs.length, `${label} observed log count`);
	assert.equal(observation.logsDigest, logsEvidenceDigest(observation.logs), `${label} observed logs digest`);
	assert.ok(observation.stats && typeof observation.stats === 'object' && !Array.isArray(observation.stats), `${label} observed stats`);
	assert.equal(observation.stats.queued, 0, `${label} observed no queued item`);
	assert.equal(observation.stats.running, 0, `${label} observed no running item`);
	assert.ok(observation.stats[item.status] > 0, `${label} observed terminal status count`);
	const addedLogs = newLogs(observation.logs, checkpointTarget, item.itemId);
	assert.equal(successfulReindexLog(addedLogs, checkpointTarget, intent, item), undefined, `${label} has no post-dispatch success log`);
	assert.equal(
		failedReindexLog(addedLogs, checkpointTarget, intent, item),
		undefined,
		`${label} has no post-dispatch terminal-failure log`,
	);
	return observedAtEpochMs;
}

function assertLegacyNoEffectIntentEvidence(intent, checkpointTarget) {
	const resolution = intent.resolution;
	assert.equal(resolution?.kind, 'provider_patch_ack_no_observable_effect', `${intent.resourceId} legacy no-effect failed intent kind`);
	assert.equal(resolution.operatorApproval, LEGACY_NO_EFFECT_APPROVAL, `${intent.resourceId} legacy no-effect operator approval`);
	assert.equal(resolution.checkpointDigest, intent.checkpointDigest, `${intent.resourceId} legacy no-effect checkpoint digest`);
	assert.equal(
		resolution.mutationEvidence?.method,
		'PATCH item sync with wait_for_completion=true',
		`${intent.resourceId} legacy no-effect mutation method`,
	);
	assert.equal(resolution.mutationEvidence?.httpStatus, 200, `${intent.resourceId} legacy no-effect HTTP status`);
	assert.match(resolution.mutationEvidence?.responseDigest ?? '', /^[0-9a-f]{64}$/, `${intent.resourceId} legacy response digest`);
	assert.match(resolution.mutationEvidence?.cfRay ?? '', /^[0-9a-f]+-[A-Z]{3}$/, `${intent.resourceId} legacy CF-Ray`);
	assert.equal(
		resolution.mutationEvidence?.responseEvidenceUnavailable,
		null,
		`${intent.resourceId} legacy response evidence is available`,
	);
	assert.equal(resolution.mutationEvidence?.responseContract, 'success=true/result=null', `${intent.resourceId} legacy response contract`);
	assert.ok(
		Number.isSafeInteger(resolution.dispatchAgeMs) && resolution.dispatchAgeMs >= NO_EFFECT_MINIMUM_DISPATCH_AGE_MS,
		`${intent.resourceId} legacy no-effect dispatch age`,
	);
	assert.equal(resolution.observations?.length, 2, `${intent.resourceId} legacy no-effect observations`);
	const [first, second] = resolution.observations;
	const firstObservedAtEpochMs = assertNoAdvancementObservation(first, checkpointTarget, intent, `${intent.resourceId} legacy first`);
	const secondObservedAtEpochMs = assertNoAdvancementObservation(second, checkpointTarget, intent, `${intent.resourceId} legacy second`);
	assert.deepEqual(first.item, checkpointTarget.item, `${intent.resourceId} legacy first item matches checkpoint`);
	assert.deepEqual(second.item, checkpointTarget.item, `${intent.resourceId} legacy second item matches checkpoint`);
	assert.deepEqual(first.logs, checkpointTarget.baselineLogs, `${intent.resourceId} legacy first logs match checkpoint`);
	assert.deepEqual(second.logs, checkpointTarget.baselineLogs, `${intent.resourceId} legacy second logs match checkpoint`);
	assert.ok(
		firstObservedAtEpochMs - intent.dispatchedAtEpochMs >= NO_EFFECT_MINIMUM_DISPATCH_AGE_MS,
		`${intent.resourceId} legacy first observation follows the minimum dispatch age`,
	);
	assert.ok(
		secondObservedAtEpochMs - firstObservedAtEpochMs >= NO_EFFECT_STABILIZATION_MS,
		`${intent.resourceId} legacy observations span the stabilization interval`,
	);
	assert.ok(intent.resolvedAtEpochMs >= secondObservedAtEpochMs, `${intent.resourceId} legacy resolution follows both observations`);
	assert.deepEqual(noEffectComparable(second), noEffectComparable(first), `${intent.resourceId} legacy no-effect evidence is stable`);
	return second.item;
}

function assertNoAdvancementIntentEvidence(intent, checkpointTarget) {
	const resolution = intent.resolution;
	assert.equal(resolution?.kind, 'provider_key_reindex_no_terminal_advancement', `${intent.resourceId} no-advancement failed intent kind`);
	assert.equal(resolution.operatorApproval, KEY_REINDEX_NO_EFFECT_APPROVAL, `${intent.resourceId} no-advancement failed operator approval`);
	assert.equal(resolution.checkpointDigest, intent.checkpointDigest, `${intent.resourceId} no-advancement failed checkpoint digest`);
	assert.equal(resolution.mutationEvidence?.method, MUTATION_METHOD, `${intent.resourceId} no-advancement failed mutation method`);
	const responseEvidenceUnavailable = resolution.mutationEvidence?.responseEvidenceUnavailable;
	if (resolution.mutationEvidence?.responseDigest === null) {
		assert.equal(resolution.mutationEvidence?.cfRay, null, `${intent.resourceId} no-advancement failed response evidence is paired`);
		assert.equal(
			responseEvidenceUnavailable,
			RESPONSE_EVIDENCE_UNAVAILABLE,
			`${intent.resourceId} no-advancement failed unavailable-response acknowledgement`,
		);
	} else {
		assert.match(
			resolution.mutationEvidence?.responseDigest ?? '',
			/^[0-9a-f]{64}$/,
			`${intent.resourceId} no-advancement failed response digest`,
		);
		assert.match(resolution.mutationEvidence?.cfRay ?? '', /^[0-9a-f]+-[A-Z]{3}$/, `${intent.resourceId} no-advancement failed CF-Ray`);
		assert.equal(responseEvidenceUnavailable, null, `${intent.resourceId} no-advancement failed does not disclaim available evidence`);
	}
	assert.ok(
		Number.isSafeInteger(resolution.dispatchAgeMs) && resolution.dispatchAgeMs >= NO_EFFECT_MINIMUM_DISPATCH_AGE_MS,
		`${intent.resourceId} no-advancement failed dispatch age`,
	);
	assert.equal(resolution.observations?.length, 2, `${intent.resourceId} no-advancement failed observations`);
	const [first, second] = resolution.observations;
	const firstObservedAtEpochMs = assertNoAdvancementObservation(first, checkpointTarget, intent, `${intent.resourceId} first`);
	const secondObservedAtEpochMs = assertNoAdvancementObservation(second, checkpointTarget, intent, `${intent.resourceId} second`);
	assert.ok(
		firstObservedAtEpochMs - intent.dispatchedAtEpochMs >= NO_EFFECT_MINIMUM_DISPATCH_AGE_MS,
		`${intent.resourceId} first observation follows the minimum dispatch age`,
	);
	assert.ok(
		secondObservedAtEpochMs - firstObservedAtEpochMs >= NO_EFFECT_STABILIZATION_MS,
		`${intent.resourceId} observations span the stabilization interval`,
	);
	assert.ok(intent.resolvedAtEpochMs >= secondObservedAtEpochMs, `${intent.resourceId} resolution follows both observations`);
	assert.deepEqual(noEffectComparable(second), noEffectComparable(first), `${intent.resourceId} no-advancement evidence is stable`);
	return second.item;
}

function isObservedNoEffectFailure(intent) {
	return (
		intent?.state === 'failed' &&
		['provider_patch_ack_no_observable_effect', 'provider_key_reindex_no_terminal_advancement'].includes(intent.resolution?.kind)
	);
}

function assertObservedNoEffectIntentEvidence(intent, checkpointTarget) {
	if (intent.resolution?.kind === 'provider_patch_ack_no_observable_effect') {
		return assertLegacyNoEffectIntentEvidence(intent, checkpointTarget);
	}
	return assertNoAdvancementIntentEvidence(intent, checkpointTarget);
}

function previousFailedIntentFromAdoption(intent, adoption, label) {
	assert.ok(
		Number.isSafeInteger(adoption?.previousResolvedAtEpochMs) &&
			adoption.previousResolvedAtEpochMs >= intent.dispatchedAtEpochMs &&
			adoption.previousResolvedAtEpochMs < intent.resolvedAtEpochMs,
		`${label} late completion previous resolution timestamp`,
	);
	const adoptedAtEpochMs = timestampMs(adoption?.adoptedAt, `${label} late completion adoption timestamp`);
	assert.ok(
		adoptedAtEpochMs >= adoption.previousResolvedAtEpochMs && Math.abs(adoptedAtEpochMs - intent.resolvedAtEpochMs) <= 1,
		`${label} late completion adoption timestamp matches the ledger resolution`,
	);
	return {
		...intent,
		state: 'failed',
		resolvedAtEpochMs: adoption.previousResolvedAtEpochMs,
		resolution: adoption.previousResolution,
	};
}

function assertLegacyPatchLateCompletionEvidence(intent, checkpointTarget, item, successLog) {
	assert.equal(intent.state, 'completed', `${item.resourceId} legacy late completion intent state`);
	const resolution = intent.resolution;
	assert.equal(resolution?.kind, 'legacy_item_patch_late_completion_adopted', `${item.resourceId} legacy late completion kind`);
	assert.equal(resolution?.checkpointSchemaVersion, 3, `${item.resourceId} legacy late completion checkpoint schema`);
	assert.equal(resolution?.mutationMethod, 'legacy-item-patch-sync-v1', `${item.resourceId} legacy late completion mutation method`);
	assert.equal(resolution?.resourceId, item.resourceId, `${item.resourceId} legacy late completion resource`);
	assert.equal(resolution?.resourceKey, item.key, `${item.resourceId} legacy late completion key`);
	assert.equal(resolution?.sourceId, item.sourceId, `${item.resourceId} legacy late completion source`);
	assert.equal(resolution?.itemId, item.itemId, `${item.resourceId} legacy late completion item`);
	assert.equal(
		resolution?.canonicalContentSha256,
		checkpointTarget.resource.canonicalContentSha256,
		`${item.resourceId} legacy late completion content SHA`,
	);
	assert.equal(
		resolution?.canonicalContentBytes,
		checkpointTarget.resource.canonicalContentBytes,
		`${item.resourceId} legacy late completion content bytes`,
	);
	assert.equal(resolution?.chunksCount, item.chunksCount, `${item.resourceId} legacy late completion chunks`);
	assert.equal(resolution?.itemLastSeenAt, item.lastSeenAt, `${item.resourceId} legacy late completion last-seen`);
	assert.equal(resolution?.intentDispatchedAtEpochMs, intent.dispatchedAtEpochMs, `${item.resourceId} legacy late completion dispatch`);
	assert.deepEqual(resolution?.successLog, successLog, `${item.resourceId} legacy late completion success log`);
	assert.equal(
		resolution?.mutationResult?.recovery,
		'legacy-late-completion-adopted-without-redispatch',
		`${item.resourceId} legacy late completion recovery method`,
	);
	const previousIntent = previousFailedIntentFromAdoption(intent, resolution?.lateCompletionAdoption, item.resourceId);
	assertLegacyNoEffectIntentEvidence(previousIntent, checkpointTarget);
	assert.deepEqual(
		resolution?.mutationResult?.originalMutationEvidence,
		previousIntent.resolution.mutationEvidence,
		`${item.resourceId} legacy late completion preserves response evidence`,
	);
}

function assertFailedIntentEvidence(intent, checkpointTarget, item) {
	const resolution = intent.resolution;
	if (isObservedNoEffectFailure(intent)) {
		const observedItem = assertObservedNoEffectIntentEvidence(intent, checkpointTarget);
		assert.deepEqual(item, observedItem, `${item.resourceId} observed no-effect item remains terminal`);
		return;
	}
	assert.equal(resolution?.kind, 'canonical_key_reindex_failed', `${item.resourceId} failed intent kind`);
	assert.equal(resolution?.checkpointSchemaVersion, 4, `${item.resourceId} failed intent checkpoint schema`);
	assert.equal(resolution?.mutationMethod, MUTATION_METHOD, `${item.resourceId} failed intent mutation method`);
	assert.equal(resolution?.resourceId, item.resourceId, `${item.resourceId} failed intent resource`);
	assert.equal(resolution?.resourceKey, item.key, `${item.resourceId} failed intent key`);
	assert.equal(resolution?.sourceId, item.sourceId, `${item.resourceId} failed intent source`);
	assert.equal(resolution?.previousItemId, checkpointTarget.item.itemId, `${item.resourceId} failed intent prior item`);
	assert.equal(resolution?.failedItemId, item.itemId, `${item.resourceId} failed intent observed item`);
	assert.equal(
		resolution?.canonicalContentSha256,
		checkpointTarget.resource.canonicalContentSha256,
		`${item.resourceId} failed intent content SHA`,
	);
	assert.equal(
		resolution?.canonicalContentBytes,
		checkpointTarget.resource.canonicalContentBytes,
		`${item.resourceId} failed intent content bytes`,
	);
	assert.deepEqual(
		resolution?.failedItem,
		{
			error: item.error,
			lastSeenAt: item.lastSeenAt,
			status: item.status,
		},
		`${item.resourceId} failed intent item evidence`,
	);
	assert.equal(resolution?.failedLog?.fileKey, item.key, `${item.resourceId} failed intent log key`);
	assert.ok(
		typeof resolution?.failedLog?.errorType === 'string' || ['error', 'outdated', 'skipped'].includes(resolution?.failedLog?.action),
		`${item.resourceId} failed intent log evidence`,
	);
	assert.ok(
		timestampMs(resolution.failedLog.timestamp, `${item.resourceId} failed intent log`) >= intent.dispatchedAtEpochMs - LOG_CLOCK_SKEW_MS,
		`${item.resourceId} failed intent log follows dispatch`,
	);
}

async function verifyUnattemptedExternalCompletion(accountId, apiToken, db, checkpoint, target) {
	const item = await loadOwnedItemByKey(accountId, apiToken, target.item.key, `${target.item.resourceId} external completion`);
	assertItemIdentity(item, target, `${target.item.resourceId} external completion`);
	assert.equal(item.status, 'completed', `${item.resourceId} external completion status`);
	assert.equal(item.error, null, `${item.resourceId} external completion error`);
	assert.ok(item.chunksCount > 0, `${item.resourceId} external completion chunks`);
	assert.ok(
		timestampMs(item.lastSeenAt, `${item.resourceId} external completion last-seen`) >
			timestampMs(target.item.lastSeenAt, `${item.resourceId} checkpoint last-seen`),
		`${item.resourceId} external completion advanced last-seen`,
	);
	const logs = await loadLogs(accountId, apiToken, item.itemId, `${target.item.resourceId} external completion`);
	const successLog = successfulExternalReindexLog(newLogs(logs, target, item.itemId), checkpoint, target, item);
	assert.ok(successLog, `${item.resourceId} external completion has a post-checkpoint success log`);
	await assertJitCanonicalFence(accountId, apiToken, db, target, item);
	return {
		kind: 'provider_reindex_completed_without_operator_intent',
		resourceId: item.resourceId,
		itemId: item.itemId,
		itemLastSeenAt: item.lastSeenAt,
		successLog,
	};
}

async function assertTargetApplyState(
	accountId,
	apiToken,
	db,
	checkpoint,
	target,
	intent,
	terminalItem,
	inProgressItem,
	allowUnattemptedExternalCompletions,
) {
	if (!intent) {
		if (terminalItem) {
			assert.equal(inProgressItem, undefined, `${target.item.resourceId} unattempted target is not in progress`);
			assert.deepEqual(terminalItem, target.item, `${target.item.resourceId} unattempted target matches checkpoint`);
			return null;
		}
		assert.equal(inProgressItem, undefined, `${target.item.resourceId} unattempted target is not in progress`);
		assert.equal(
			allowUnattemptedExternalCompletions,
			true,
			`${target.item.resourceId} unattempted target remains terminal unless external completion evidence is approved`,
		);
		return verifyUnattemptedExternalCompletion(accountId, apiToken, db, checkpoint, target);
	}
	if (intent.state === 'failed') {
		if (isObservedNoEffectFailure(intent)) {
			const observedTerminalItem = assertObservedNoEffectIntentEvidence(intent, target);
			if (terminalItem) {
				assert.equal(inProgressItem, undefined, `${target.item.resourceId} failed target is not in progress`);
				assert.deepEqual(
					terminalItem,
					observedTerminalItem,
					`${target.item.resourceId} failed target remains at the observed terminal state`,
				);
			} else if (inProgressItem) {
				assert.equal(
					inProgressItem.resourceId,
					target.item.resourceId,
					`${target.item.resourceId} late completion remains on the approved resource`,
				);
			}
			return null;
		}
		assert.ok(terminalItem, `${target.item.resourceId} failed target remains terminal`);
		assert.equal(inProgressItem, undefined, `${target.item.resourceId} failed target is not in progress`);
		assertFailedIntentEvidence(intent, target, terminalItem);
		return null;
	}
	if (intent.state === 'abandoned') {
		assert.ok(terminalItem, `${target.item.resourceId} abandoned target remains terminal`);
		assert.equal(inProgressItem, undefined, `${target.item.resourceId} abandoned target is not in progress`);
		assert.deepEqual(terminalItem, target.item, `${target.item.resourceId} abandoned target matches checkpoint`);
		return null;
	}
	if (intent.state === 'completed') {
		assert.equal(terminalItem ?? inProgressItem ?? null, null, `${target.item.resourceId} completed intent is terminal-free`);
		return null;
	}
	if (intent.state === 'prepared') {
		assert.ok(terminalItem, `${target.item.resourceId} prepared target remains terminal`);
		assert.equal(inProgressItem, undefined, `${target.item.resourceId} prepared target is not in progress`);
		assert.deepEqual(terminalItem, target.item, `${target.item.resourceId} prepared target matches checkpoint`);
		return null;
	}
	assert.equal(intent.state, 'dispatched', `${target.item.resourceId} unresolved intent is dispatched`);
	return null;
}

async function assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents, { allowUnattemptedExternalCompletions = false } = {}) {
	const [dbFences, instanceFence, stats] = await Promise.all([
		loadDbFences(db),
		loadInstanceFence(accountId, apiToken),
		loadStats(accountId, apiToken),
	]);
	assert.deepEqual(dbFences, checkpoint.dbFences, 'global database/search fences remain frozen');
	assert.deepEqual(instanceFence, checkpoint.instanceFence, 'global AI Search instance fence remains frozen');
	const statusItems = {};
	for (const status of NON_COMPLETED_STATUSES) {
		statusItems[status] = (await listStatusItems(accountId, apiToken, status))
			.map((item) => normalizeItem(item, `${status} ${item.id}`))
			.sort((left, right) => compareAscii(left.resourceId, right.resourceId));
		assert.equal(statusItems[status].length, stats[status], `${status} listing matches stats`);
	}
	const nonCompletedItems = NON_COMPLETED_STATUSES.flatMap((status) => statusItems[status]);
	assert.equal(
		new Set(nonCompletedItems.map((item) => item.resourceId)).size,
		nonCompletedItems.length,
		'non-completed resource IDs are unique',
	);
	assert.equal(
		stats.completed + nonCompletedItems.length,
		checkpoint.dbFences.eligibleCount,
		'completed and non-completed items account for the frozen eligible corpus',
	);
	const targetsByResource = new Map(checkpoint.targets.map((target) => [target.item.resourceId, target]));
	for (const item of nonCompletedItems) {
		const target = targetsByResource.get(item.resourceId);
		assert.ok(target, `unapproved ${item.status} item ${item.itemId}/${item.key}`);
		assert.equal(item.key, target.item.key, `${item.resourceId} non-completed item key`);
	}
	const terminalByResource = new Map(TERMINAL_STATUSES.flatMap((status) => statusItems[status]).map((item) => [item.resourceId, item]));
	const inProgressItems = IN_PROGRESS_STATUSES.flatMap((status) => statusItems[status]);
	assert.ok(inProgressItems.length <= 1, 'at most one approved item is in progress');
	for (const item of inProgressItems) {
		const target = targetsByResource.get(item.resourceId);
		assert.ok(target, `${item.resourceId} in-progress item has an approved target`);
		const intent = intents.get(target.item.itemId);
		assert.ok(
			intent?.state === 'dispatched' || isObservedNoEffectFailure(intent),
			`${item.resourceId} in-progress item has a dispatched or late-completing intent`,
		);
	}
	const externallyCompletedTargets = [];
	for (const target of checkpoint.targets) {
		const intent = intents.get(target.item.itemId);
		const terminalItem = terminalByResource.get(target.item.resourceId);
		const inProgressItem = inProgressItems.find((item) => item.resourceId === target.item.resourceId);
		const externalCompletion = await assertTargetApplyState(
			accountId,
			apiToken,
			db,
			checkpoint,
			target,
			intent,
			terminalItem,
			inProgressItem,
			allowUnattemptedExternalCompletions,
		);
		if (externalCompletion) externallyCompletedTargets.push(externalCompletion);
	}
	return { dbFences, instanceFence, stats, statusItems, externallyCompletedTargets };
}

async function assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item) {
	const [resource, storedContent] = await Promise.all([
		loadCanonicalResource(db, checkpointTarget.item.resourceId),
		downloadItemContent(accountId, apiToken, item.itemId, checkpointTarget.item.resourceId),
	]);
	assert.deepEqual(resource, checkpointTarget.resource, `${checkpointTarget.item.resourceId} canonical DB fence`);
	assert.deepEqual(storedContent, checkpointTarget.storedContent, `${checkpointTarget.item.resourceId} stored content fence`);
	assertCanonicalItem(item, resource, storedContent, checkpointTarget.item.resourceId);
	return { resource, storedContent };
}

async function resolveCompletedRetryIntent(db, checkpoint, checkpointTarget, intent, item, successLog, mutationResult) {
	if (intent.state === 'completed') return intent;
	if (intent.state === 'dispatched') {
		return resolveRetryIntent(
			db,
			intent,
			'completed',
			completedResolution(checkpoint, checkpointTarget, intent, item, successLog, mutationResult),
		);
	}
	assert.equal(intent.state, 'failed', `${item.resourceId} late completion starts from a failed intent`);
	assertObservedNoEffectIntentEvidence(intent, checkpointTarget);
	const previousResolution = intent.resolution;
	if (previousResolution.kind === 'provider_patch_ack_no_observable_effect') {
		const adoptedIntent = await adoptLateCompletionIntent(
			db,
			intent,
			legacyPatchLateCompletionResolution(checkpoint, checkpointTarget, intent, item, successLog),
		);
		assertLegacyPatchLateCompletionEvidence(adoptedIntent, checkpointTarget, item, successLog);
		return adoptedIntent;
	}
	const lateCompletionMutationResult = {
		method: MUTATION_METHOD,
		recovery: 'late-completion-adopted-without-redispatch',
		originalMutationEvidence: previousResolution.mutationEvidence,
		result: {
			id: item.itemId,
			key: item.key,
			sourceId: item.sourceId,
			status: item.status,
		},
	};
	const adoptedIntent = await adoptLateCompletionIntent(
		db,
		intent,
		completedResolution(checkpoint, checkpointTarget, intent, item, successLog, lateCompletionMutationResult, {
			previousResolvedAtEpochMs: intent.resolvedAtEpochMs,
			previousResolution,
		}),
	);
	assertCompletedIntentEvidence(adoptedIntent, checkpointTarget, item, successLog);
	return adoptedIntent;
}

async function waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, mutationResult) {
	for (let attempt = 0; attempt < ITEM_POLL_ATTEMPTS; attempt++) {
		const ownedItems = await listOwnedItemsByKey(accountId, apiToken, checkpointTarget.item.key, checkpointTarget.item.resourceId);
		if (ownedItems.length === 0) {
			if (attempt < ITEM_POLL_ATTEMPTS - 1) {
				await sleep(ITEM_POLL_INTERVAL_MS);
				continue;
			}
			break;
		}
		const item = ownedItems[0];
		assert.equal(item.resourceId, checkpointTarget.item.resourceId, `${item.resourceId} current resource`);
		assert.equal(item.sourceId, 'builtin', `${item.resourceId} current source`);
		assert.deepEqual(
			itemCustomMetadata(item.metadata, item.resourceId),
			checkpointTarget.resource.canonicalMetadata,
			`${item.resourceId} current canonical metadata`,
		);
		const logs = await loadLogs(accountId, apiToken, item.itemId, checkpointTarget.item.resourceId);
		const addedLogs = newLogs(logs, checkpointTarget, item.itemId);
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
			const resolvedIntent = await resolveCompletedRetryIntent(db, checkpoint, checkpointTarget, intent, item, successLog, mutationResult);
			return {
				itemId: item.itemId,
				resourceId: item.resourceId,
				status: item.status,
				chunksCount: item.chunksCount,
				successLog,
				mutationResult,
				intent: resolvedIntent,
				outcome: 'completed',
			};
		}
		const failedLog = failedReindexLog(addedLogs, checkpointTarget, intent, item);
		if (failedLog && ['error', 'outdated', 'skipped'].includes(item.status)) {
			let resolvedIntent = intent;
			if (intent.state === 'dispatched') {
				resolvedIntent = await resolveRetryIntent(
					db,
					intent,
					'failed',
					failedResolution(checkpoint, checkpointTarget, intent, item, failedLog, mutationResult),
				);
			}
			return {
				itemId: item.itemId,
				resourceId: item.resourceId,
				status: item.status,
				chunksCount: item.chunksCount,
				failedLog,
				mutationResult,
				intent: resolvedIntent,
				outcome: 'failed',
			};
		}
		if (attempt < ITEM_POLL_ATTEMPTS - 1) await sleep(ITEM_POLL_INTERVAL_MS);
	}
	throw new Error(`${checkpointTarget.item.resourceId} retry acknowledgement remained ambiguous: ${JSON.stringify(mutationResult)}`);
}

async function captureNoEffectObservation(accountId, apiToken, db, checkpoint, checkpointTarget, intents, legacyPatch, intent) {
	const [global, item, instanceLastActivity, observedAt] = await Promise.all([
		assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents),
		loadOwnedItemByKey(accountId, apiToken, checkpointTarget.item.key, checkpointTarget.item.resourceId),
		loadInstanceLastActivity(accountId, apiToken),
		loadDatabaseClock(db, 'no-effect observation'),
	]);
	const logs = await loadLogs(accountId, apiToken, item.itemId, checkpointTarget.item.resourceId);
	assert.equal(global.stats.queued, 0, 'no-effect observation has no queued item');
	assert.equal(global.stats.running, 0, 'no-effect observation has no running item');
	assert.ok(TERMINAL_STATUSES.includes(item.status), 'no-effect observation item is terminal');
	const terminalListingItem = global.statusItems[item.status]?.find(
		(listedItem) => listedItem.resourceId === checkpointTarget.item.resourceId,
	);
	assert.deepEqual(terminalListingItem, item, 'no-effect by-key item matches the terminal status listing');
	if (legacyPatch) {
		assertItemIdentity(item, checkpointTarget, checkpointTarget.item.resourceId);
		assert.deepEqual(item, checkpointTarget.item, 'legacy no-effect item matches the checkpoint');
		assert.deepEqual(logs, checkpointTarget.baselineLogs, 'legacy no-effect logs match the checkpoint');
	} else {
		assert.equal(item.resourceId, checkpointTarget.item.resourceId, 'no-advancement resource matches the checkpoint');
		assert.equal(item.key, checkpointTarget.item.key, 'no-advancement key matches the checkpoint');
		assert.equal(item.sourceId, 'builtin', 'no-advancement item remains app-owned');
		assert.ok(TERMINAL_STATUSES.includes(item.status), 'no-advancement item is terminal');
		assert.deepEqual(
			itemCustomMetadata(item.metadata, item.resourceId),
			checkpointTarget.resource.canonicalMetadata,
			'no-advancement item retains canonical metadata',
		);
		const addedLogs = newLogs(logs, checkpointTarget, item.itemId);
		assert.equal(
			successfulReindexLog(addedLogs, checkpointTarget, intent, item),
			undefined,
			'no-advancement item has no post-dispatch success log',
		);
		assert.equal(
			failedReindexLog(addedLogs, checkpointTarget, intent, item),
			undefined,
			'no-advancement item has no post-dispatch terminal-failure log',
		);
	}
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
	return {
		observedAt,
		instanceLastActivity,
		item,
		itemDigest: itemEvidenceDigest(item),
		logs,
		logCount: logs.length,
		logsDigest: logsEvidenceDigest(logs),
		stats: global.stats,
		terminalListingItem,
	};
}

function noEffectComparable(observation) {
	const { observedAt: _observedAt, ...comparable } = observation;
	return comparable;
}

async function verifyLegacyAdoptedCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, intents) {
	assert.equal(intent?.state, 'completed', `${checkpointTarget.item.resourceId} legacy adopted intent is completed`);
	const global = await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents, {
		allowUnattemptedExternalCompletions: true,
	});
	const item = await loadOwnedItemByKey(accountId, apiToken, checkpointTarget.item.key, checkpointTarget.item.resourceId);
	assert.equal(item.resourceId, checkpointTarget.item.resourceId, `${item.resourceId} legacy adopted resource`);
	assert.equal(item.status, 'completed', `${item.resourceId} legacy adopted item status`);
	assert.equal(item.error, null, `${item.resourceId} legacy adopted item error`);
	assert.ok(item.chunksCount > 0, `${item.resourceId} legacy adopted item chunks`);
	assert.deepEqual(
		itemCustomMetadata(item.metadata, item.resourceId),
		checkpointTarget.resource.canonicalMetadata,
		`${item.resourceId} legacy adopted canonical metadata`,
	);
	assert.ok(
		timestampMs(item.lastSeenAt, `${item.resourceId} legacy adopted last-seen`) >
			timestampMs(checkpointTarget.item.lastSeenAt, `${item.resourceId} legacy checkpoint last-seen`),
		`${item.resourceId} legacy adopted item advanced last-seen`,
	);
	const logs = await loadLogs(accountId, apiToken, item.itemId, checkpointTarget.item.resourceId);
	const successLog = successfulReindexLog(newLogs(logs, checkpointTarget, item.itemId), checkpointTarget, intent, item);
	assert.ok(successLog, `${item.resourceId} legacy adopted successful retry log`);
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
	assertLegacyPatchLateCompletionEvidence(intent, checkpointTarget, item, successLog);
	return { global, intent, item, successLog };
}

async function reconcileLegacyLateCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, intents) {
	assertLegacyNoEffectIntentEvidence(intent, checkpointTarget);
	await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents, {
		allowUnattemptedExternalCompletions: true,
	});
	const item = await loadOwnedItemByKey(accountId, apiToken, checkpointTarget.item.key, checkpointTarget.item.resourceId);
	assert.equal(item.resourceId, checkpointTarget.item.resourceId, `${item.resourceId} legacy late-completion resource`);
	assert.deepEqual(
		itemCustomMetadata(item.metadata, item.resourceId),
		checkpointTarget.resource.canonicalMetadata,
		`${item.resourceId} legacy late-completion canonical metadata`,
	);
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
	if (!['queued', 'running', 'completed'].includes(item.status)) {
		assertFailedIntentEvidence(intent, checkpointTarget, item);
		assert.fail(`${item.resourceId} legacy no-effect item remains terminal; capture and approve a schema-4 checkpoint`);
	}
	const result = await waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, {
		method: 'PATCH item sync with wait_for_completion=true',
		recovery: 'polling-legacy-late-completion-without-redispatch',
		result: null,
	});
	assert.equal(result.intent.state, 'completed', `${item.resourceId} legacy late completion was adopted`);
	const finalIntents = await loadCheckpointIntents(db, checkpoint);
	const verified = await verifyLegacyAdoptedCompletion(
		accountId,
		apiToken,
		db,
		checkpoint,
		checkpointTarget,
		finalIntents.get(checkpointTarget.item.itemId),
		finalIntents,
	);
	return {
		event: 'search_outdated_retry_251_legacy_late_completion_adopted',
		checkpointRunId: checkpoint.checkpointRunId,
		itemId: checkpointTarget.item.itemId,
		resourceId: checkpointTarget.item.resourceId,
		result,
		verified,
	};
}

async function reconcileAlreadyAdoptedLegacyCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, intents) {
	const verified = await verifyLegacyAdoptedCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, intents);
	return {
		event: 'search_outdated_retry_251_legacy_late_completion_already_adopted',
		checkpointRunId: checkpoint.checkpointRunId,
		itemId: checkpointTarget.item.itemId,
		resourceId: checkpointTarget.item.resourceId,
		verified,
	};
}

async function reconcileNoEffectDispatch(accountId, apiToken, db, checkpoint) {
	const legacyPatch = checkpoint.schemaVersion === 3;
	if (legacyPatch) {
		assert.equal(checkpoint.mutationMethod, undefined, 'legacy PATCH checkpoint has no mutation method');
		assert.equal(noEffectApproval, LEGACY_NO_EFFECT_APPROVAL, 'legacy PATCH no-effect operator approval');
		assert.match(mutationResponseDigest ?? '', /^[0-9a-f]{64}$/, 'legacy PATCH response digest');
		assert.match(mutationCfRay ?? '', /^[0-9a-f]+-[A-Z]{3}$/, 'legacy PATCH CF-Ray');
		assert.equal(unavailableResponseEvidence, null, 'legacy PATCH has response evidence');
	} else {
		assert.equal(checkpoint.schemaVersion, 4, 'key reindex no-effect checkpoint schema');
		assert.equal(checkpoint.mutationMethod, MUTATION_METHOD, 'key reindex no-effect mutation method');
		assert.equal(noEffectApproval, KEY_REINDEX_NO_EFFECT_APPROVAL, 'key reindex no-effect operator approval');
	}
	assert.equal(checkpoint.digest, approvalDigest, 'operator approval digest matches the checkpoint');
	const checkpointTarget = checkpoint.targets.find((target) => target.item.itemId === reconciliationItemId);
	assert.ok(checkpointTarget, 'reconciliation item belongs to the approved checkpoint');
	const intents = await loadCheckpointIntents(db, checkpoint);
	const intent = intents.get(reconciliationItemId);
	assert.ok(intent, 'reconciliation retry intent exists');
	if (legacyPatch && intent.state === 'failed' && intent.resolution?.kind === 'provider_patch_ack_no_observable_effect') {
		return reconcileLegacyLateCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, intents);
	}
	if (legacyPatch && intent.state === 'completed' && intent.resolution?.kind === 'legacy_item_patch_late_completion_adopted') {
		return reconcileAlreadyAdoptedLegacyCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, intents);
	}
	const unresolvedIntents = [...intents.values()].filter((intent) => ['prepared', 'dispatched'].includes(intent.state));
	assert.equal(unresolvedIntents.length, 1, 'checkpoint has exactly one unresolved retry intent');
	assert.equal(intent.state, 'dispatched', 'reconciliation retry intent remains dispatched');
	const dispatchAgeMs =
		timestampMs(await loadDatabaseClock(db, 'no-effect dispatch-age'), 'no-effect dispatch-age') - intent.dispatchedAtEpochMs;
	assert.ok(
		dispatchAgeMs >= NO_EFFECT_MINIMUM_DISPATCH_AGE_MS,
		`reconciliation dispatch is at least ${NO_EFFECT_MINIMUM_DISPATCH_AGE_MS}ms old`,
	);
	const first = await captureNoEffectObservation(accountId, apiToken, db, checkpoint, checkpointTarget, intents, legacyPatch, intent);
	process.stdout.write(
		`${JSON.stringify({
			event: 'search_outdated_retry_251_no_effect_observation',
			sequence: 1,
			checkpointRunId: checkpoint.checkpointRunId,
			itemId: reconciliationItemId,
			resourceId: checkpointTarget.item.resourceId,
			observation: first,
		})}\n`,
	);
	await sleep(NO_EFFECT_STABILIZATION_MS);
	const second = await captureNoEffectObservation(accountId, apiToken, db, checkpoint, checkpointTarget, intents, legacyPatch, intent);
	assert.deepEqual(noEffectComparable(second), noEffectComparable(first), 'no-effect observations remained stable');
	const resolution = {
		kind: legacyPatch ? 'provider_patch_ack_no_observable_effect' : 'provider_key_reindex_no_terminal_advancement',
		operatorApproval: noEffectApproval,
		checkpointDigest: checkpoint.digest,
		dispatchAgeMs,
		mutationEvidence: {
			method: legacyPatch ? 'PATCH item sync with wait_for_completion=true' : MUTATION_METHOD,
			httpStatus: legacyPatch ? 200 : null,
			cfRay: mutationCfRay,
			responseDigest: mutationResponseDigest,
			responseEvidenceUnavailable: unavailableResponseEvidence,
			responseContract: legacyPatch ? 'success=true/result=null' : 'unavailable-or-non-advancing',
		},
		observations: [first, second],
	};
	const resolvedIntent = await resolveRetryIntent(db, intent, 'failed', resolution);
	assertObservedNoEffectIntentEvidence(resolvedIntent, checkpointTarget);
	await assertGlobalUnresolvedIntents(db);
	return {
		event: 'search_outdated_retry_251_no_effect_reconciled',
		checkpointRunId: checkpoint.checkpointRunId,
		itemId: reconciliationItemId,
		resourceId: checkpointTarget.item.resourceId,
		resolvedIntent,
		resolution,
	};
}

async function reconcileExistingIntent(accountId, apiToken, db, checkpoint, checkpointTarget, existingIntent) {
	let intent = existingIntent;
	if (intent.state === 'prepared') intent = await abandonPreparedIntent(db, intent);
	if (
		intent.state === 'abandoned' ||
		(intent.state === 'failed' && intent.resolution?.kind !== 'provider_key_reindex_no_terminal_advancement')
	) {
		const item = await loadOwnedItemByKey(accountId, apiToken, checkpointTarget.item.key, checkpointTarget.item.resourceId);
		await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
		return {
			itemId: item.itemId,
			resourceId: item.resourceId,
			status: item.status,
			chunksCount: item.chunksCount,
			mutationResult: intent.resolution?.mutationResult ?? null,
			intent,
			outcome: intent.state,
		};
	}
	if (intent.state === 'failed') assertNoAdvancementIntentEvidence(intent, checkpointTarget);
	const item = await loadOwnedItemByKey(accountId, apiToken, checkpointTarget.item.key, checkpointTarget.item.resourceId);
	assert.equal(item.resourceId, checkpointTarget.item.resourceId, `${item.resourceId} current resource`);
	assert.deepEqual(
		itemCustomMetadata(item.metadata, item.resourceId),
		checkpointTarget.resource.canonicalMetadata,
		`${item.resourceId} current canonical metadata`,
	);
	const logs = await loadLogs(accountId, apiToken, item.itemId, checkpointTarget.item.resourceId);
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
	const addedLogs = newLogs(logs, checkpointTarget, item.itemId);
	const successLog = successfulReindexLog(addedLogs, checkpointTarget, intent, item);
	if (item.status === 'completed' && item.error === null && successLog) {
		return waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, {
			method: MUTATION_METHOD,
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
			method: MUTATION_METHOD,
			acknowledged: false,
			ambiguous: true,
			cfRay: null,
			error: 'reconciling an in-progress durable intent',
			httpStatus: null,
			responseDigest: null,
			result: null,
		});
	}
	const failedLog = failedReindexLog(addedLogs, checkpointTarget, intent, item);
	if (failedLog && ['error', 'outdated', 'skipped'].includes(item.status)) {
		if (intent.state === 'dispatched') {
			intent = await resolveRetryIntent(
				db,
				intent,
				'failed',
				failedResolution(checkpoint, checkpointTarget, intent, item, failedLog, null),
			);
		}
		return {
			itemId: item.itemId,
			resourceId: item.resourceId,
			status: item.status,
			chunksCount: item.chunksCount,
			failedLog,
			mutationResult: null,
			intent,
			outcome: 'failed',
		};
	}
	if (intent.state === 'failed') {
		assertFailedIntentEvidence(intent, checkpointTarget, item);
		return {
			itemId: item.itemId,
			resourceId: item.resourceId,
			status: item.status,
			chunksCount: item.chunksCount,
			mutationResult: intent.resolution?.mutationResult ?? null,
			intent,
			outcome: 'failed',
		};
	}
	return waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, {
		method: MUTATION_METHOD,
		acknowledged: false,
		ambiguous: true,
		cfRay: null,
		error: 'reconciling a durable intent without terminal post-dispatch evidence',
		httpStatus: null,
		responseDigest: null,
		result: null,
	});
}

async function reconcileOrRetryTarget(accountId, apiToken, db, checkpoint, checkpointTarget) {
	let intents = await loadCheckpointIntents(db, checkpoint);
	let intent = intents.get(checkpointTarget.item.itemId) ?? null;
	const initialGlobal = await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents);
	if (intent) return reconcileExistingIntent(accountId, apiToken, db, checkpoint, checkpointTarget, intent);
	assert.equal(initialGlobal.stats.queued, 0, 'no queued item exists before a new key reindex');
	assert.equal(initialGlobal.stats.running, 0, 'no running item exists before a new key reindex');
	const [item, logs] = await Promise.all([
		loadItem(accountId, apiToken, checkpointTarget.item.itemId, checkpointTarget.item.resourceId),
		loadLogs(accountId, apiToken, checkpointTarget.item.itemId, checkpointTarget.item.resourceId),
	]);
	assertItemIdentity(item, checkpointTarget, checkpointTarget.item.resourceId);
	assert.deepEqual(item, checkpointTarget.item, `${item.resourceId} terminal item matches checkpoint immediately before key reindex`);
	assert.deepEqual(logs, checkpointTarget.baselineLogs, `${item.resourceId} logs match checkpoint immediately before key reindex`);
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, item);
	intent = await createRetryIntent(db, checkpoint, checkpointTarget);
	intents = await loadCheckpointIntents(db, checkpoint);
	assert.deepEqual(intents.get(checkpointTarget.item.itemId), intent, `${item.resourceId} durable intent read-after-write`);
	const preDispatchGlobal = await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents);
	assert.equal(preDispatchGlobal.stats.queued, 0, 'no queued item exists immediately before key-reindex dispatch');
	assert.equal(preDispatchGlobal.stats.running, 0, 'no running item exists immediately before key-reindex dispatch');
	const [mutationItem, mutationLogs] = await Promise.all([
		loadItem(accountId, apiToken, checkpointTarget.item.itemId, `${checkpointTarget.item.resourceId} post-intent`),
		loadLogs(accountId, apiToken, checkpointTarget.item.itemId, `${checkpointTarget.item.resourceId} post-intent`),
	]);
	assert.deepEqual(mutationItem, checkpointTarget.item, `${item.resourceId} item remains pinned after intent commit`);
	assert.deepEqual(mutationLogs, checkpointTarget.baselineLogs, `${item.resourceId} logs remain pinned after intent commit`);
	await assertJitCanonicalFence(accountId, apiToken, db, checkpointTarget, mutationItem);
	intent = await dispatchRetryIntent(db, intent);
	const mutationResult = await reindexByKeyMutation(accountId, apiToken, checkpointTarget);
	process.stdout.write(
		`${JSON.stringify({
			event: 'search_outdated_retry_251_mutation_dispatched',
			checkpointRunId: checkpoint.checkpointRunId,
			itemId: checkpointTarget.item.itemId,
			resourceId: checkpointTarget.item.resourceId,
			mutationResult,
		})}\n`,
	);
	return waitForTargetCompletion(accountId, apiToken, db, checkpoint, checkpointTarget, intent, mutationResult);
}

async function captureFinalTarget(accountId, apiToken, db, checkpointTarget, intent) {
	assert.equal(intent?.state, 'completed', `${checkpointTarget.item.resourceId} retry intent completed`);
	const item = await loadOwnedItemByKey(accountId, apiToken, checkpointTarget.item.key, `${checkpointTarget.item.resourceId} final`);
	const logs = await loadLogs(accountId, apiToken, item.itemId, `${checkpointTarget.item.resourceId} final`);
	assert.equal(item.resourceId, checkpointTarget.item.resourceId, `${item.resourceId} final resource`);
	assert.deepEqual(
		itemCustomMetadata(item.metadata, item.resourceId),
		checkpointTarget.resource.canonicalMetadata,
		`${item.resourceId} final canonical metadata`,
	);
	assert.equal(item.status, 'completed', `${item.resourceId} final item status`);
	assert.equal(item.error, null, `${item.resourceId} final item error`);
	assert.ok(item.chunksCount > 0, `${item.resourceId} final chunks`);
	const addedLogs = newLogs(logs, checkpointTarget, item.itemId);
	const successLog = successfulReindexLog(addedLogs, checkpointTarget, intent, item);
	assert.ok(successLog, `${item.resourceId} final successful retry log`);
	assertCompletedIntentEvidence(intent, checkpointTarget, item, successLog);
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

async function assertBatchStateStable(accountId, apiToken, db, checkpoint, intents) {
	const first = await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents);
	await sleep(SNAPSHOT_STABILIZATION_MS);
	const second = await assertGlobalApplyState(accountId, apiToken, db, checkpoint, intents);
	assert.deepEqual(second, first, 'incomplete retry batch state remained stable');
	return second;
}

function sleep(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const { accountId, apiToken } = credentials();
const db = new pg.Client({ connectionString: databaseUrl() });
let databaseConnected = false;
let operatorLockBackendPid = null;
let operationError = null;
try {
	await db.connect();
	databaseConnected = true;
	await db.query(`SET TIME ZONE 'UTC'`);
	await db.query(`SET search_path = pg_catalog, public`);
	operatorLockBackendPid = await acquireOperatorLock(db);
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
	} else if (reconcileNoEffect) {
		const checkpoint = await loadCheckpoint(checkpointPath);
		assert.equal(checkpoint.accountId, accountId, 'checkpoint Cloudflare account');
		assert.deepEqual(await loadDbFences(db), checkpoint.dbFences, 'checkpoint database/search fences');
		assert.deepEqual(await loadInstanceFence(accountId, apiToken), checkpoint.instanceFence, 'checkpoint instance fence');
		const result = await reconcileNoEffectDispatch(accountId, apiToken, db, checkpoint);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		const checkpoint = await loadCheckpoint(checkpointPath);
		assert.equal(checkpoint.schemaVersion, 4, 'apply accepts only a canonical-key-reindex checkpoint');
		assert.equal(checkpoint.mutationMethod, MUTATION_METHOD, 'apply checkpoint mutation method');
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
					event: 'search_outdated_retry_251_item_resolved',
					processed: index + 1,
					total: checkpoint.targets.length,
					resourceId: result.resourceId,
					itemId: result.itemId,
					status: result.status,
					outcome: result.outcome,
				})}\n`,
			);
		}
		const finalIntents = await loadCheckpointIntents(db, checkpoint);
		assert.equal(finalIntents.size, checkpoint.targets.length, 'every processed target has a retry intent');
		const remaining = [...finalIntents.values()].filter((intent) => intent.state !== 'completed');
		if (remaining.length > 0) {
			const batchState = await assertBatchStateStable(accountId, apiToken, db, checkpoint, finalIntents);
			process.stdout.write(
				`${JSON.stringify(
					{
						event: 'search_outdated_retry_251_batch_requires_new_checkpoint',
						checkpointRunId: checkpoint.checkpointRunId,
						remaining: remaining.map((intent) => ({
							itemId: intent.itemId,
							resourceId: intent.resourceId,
							state: intent.state,
						})),
						results,
						batchState,
					},
					null,
					2,
				)}\n`,
			);
			throw new Error(`${remaining.length} retry target(s) remain failed or abandoned; capture and approve a new terminal checkpoint`);
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
} catch (error) {
	operationError = error;
}
const cleanupErrors = [];
if (databaseConnected && operatorLockBackendPid !== null) {
	try {
		await releaseOperatorLock(db, operatorLockBackendPid);
	} catch (error) {
		cleanupErrors.push(error);
	}
}
if (databaseConnected) {
	try {
		await db.end();
	} catch (error) {
		cleanupErrors.push(error);
	}
}
if (operationError !== null) {
	if (cleanupErrors.length > 0) {
		process.stderr.write(
			`${JSON.stringify({
				event: 'search_outdated_retry_251_cleanup_failed_after_operation_error',
				operationError: operationError instanceof Error ? operationError.message : String(operationError),
				cleanupErrors: cleanupErrors.map((error) => (error instanceof Error ? error.message : String(error))),
			})}\n`,
		);
	}
	throw operationError;
}
if (cleanupErrors.length > 0) throw cleanupErrors[0];
