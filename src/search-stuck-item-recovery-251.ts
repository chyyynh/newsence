import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { type CoreDb, queryRows, withCoreDb } from '@db/client';
import { sql } from 'drizzle-orm';
import checkpoint from '../search-stuck-item-251.json';
import {
	type CorpusDocument,
	canonicalSearchInstanceConfigMatches,
	corpusItemMetadata,
	itemKey,
	loadCorpusDocument,
	serializeDocument,
} from './ai-search';

const READ_STEP_OPTIONS = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '60 seconds',
} as const;
const MUTATION_STEP_OPTIONS = {
	retries: { limit: 0, delay: '1 second' },
	timeout: '5 minutes',
} as const;
const UTC_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

type DurableStateRow = {
	generation: number;
	generation_key: string;
	index_name: string;
	ready_is_null: boolean;
	rebuild_epoch: number;
	rebuilding_at: string;
	status: string;
};

type ResourceCheckpointRow = {
	category: string | null;
	effective_at: string;
	enrichment_status: string;
	id: string;
	indexed_translation_count: number;
	kind: string;
	latest_translation_updated_at: string;
	original_lang: string;
	resource_platform: string | null;
	scope: string;
	source_id: string | null;
	updated_at: string;
};

type CanonicalSnapshot = {
	content: string;
	contentBytes: number;
	contentSha256: string;
	document: CorpusDocument;
	durableState: DurableStateRow;
	metadata: Record<string, unknown>;
	resource: ResourceCheckpointRow;
};

type CustomMetadataEvidence = {
	category: string;
	effective_at: string;
	kind: string;
	resource_platform: string;
	source_id: string;
};

type ItemEvidence = {
	checksum: string | null;
	chunksCount: number | null;
	fileSize: number | null;
	id: string;
	key: string;
	lastSeenAt: string | null;
	status: string;
};

type CanonicalEvidence = {
	contentBytes: number;
	contentSha256: string;
	durableState: DurableStateRow;
	metadata: CustomMetadataEvidence;
	resource: ResourceCheckpointRow;
};

type RecoveryPreflight = {
	binding: { configReady: true; id: string; paused: false; workerVersionId: string };
	canonical: CanonicalEvidence;
	item: ItemEvidence & { logCount: number };
};

type RecoveryApproval = {
	approvalToken: string;
	canonicalContentSha256: string;
	instanceId: string;
	selectedWorkerVersionId: string;
	selectedWorkflowVersionId: string;
};

type RecoveryTrigger = {
	approvalToken: string;
	selectedWorkerVersionId: string;
	selectedWorkflowVersionId: string;
};

type RecoveryEnv = CoreEnv & {
	CF_VERSION_METADATA: WorkerVersionMetadata;
};

type RecoveryPostflight = {
	item: ItemEvidence;
	logCount: number;
	newestLogAt: string;
};

function fail(label: string, actual: unknown, expected: unknown): never {
	throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	if (actual !== expected) fail(label, actual, expected);
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function assertJson(actual: unknown, expected: unknown, label: string): void {
	if (canonicalJson(actual) !== canonicalJson(expected)) fail(label, actual, expected);
}

function timestampMs(value: unknown): number {
	if (typeof value === 'number') return value;
	if (typeof value !== 'string') return Number.NaN;
	return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

function requiredMetadataString(metadata: Record<string, unknown>, field: string): string {
	const value = metadata[field];
	if (typeof value !== 'string') throw new Error(`AI Search item has invalid ${field} metadata`);
	return value;
}

function normalizeCustomMetadata(metadata: Record<string, unknown> | undefined): CustomMetadataEvidence {
	if (!metadata) throw new Error('AI Search item is missing metadata');
	const effectiveAt = timestampMs(metadata.effective_at);
	if (!Number.isFinite(effectiveAt)) throw new Error('AI Search item has invalid effective_at metadata');
	return {
		category: requiredMetadataString(metadata, 'category'),
		effective_at: new Date(effectiveAt).toISOString(),
		kind: requiredMetadataString(metadata, 'kind'),
		resource_platform: requiredMetadataString(metadata, 'resource_platform'),
		source_id: requiredMetadataString(metadata, 'source_id'),
	};
}

function validateCheckpoint(): void {
	assertEqual(checkpoint.aiSearchInstanceName, 'newsence-corpus-v6', 'recovery AI Search instance');
	assertEqual(checkpoint.durableState.generation, 4, 'recovery generation');
	assertEqual(checkpoint.durableState.generationKey, 'canonical-4-kind-platform', 'recovery generation key');
	assertEqual(checkpoint.durableState.rebuildEpoch, 2, 'recovery rebuild epoch');
	assertEqual(checkpoint.item.key, itemKey(checkpoint.resource.id), 'recovery item key');
	assertEqual(checkpoint.recovery.workerName, 'newsence-search-stuck-item-recovery-251-v3', 'recovery Worker');
	assertEqual(checkpoint.recovery.workflowName, 'newsence-search-index-stuck-item-recovery-251-v3', 'recovery Workflow');
	assertEqual(checkpoint.recovery.instanceId, 'search-index-stuck-item-recovery-251-v3', 'recovery instance');
	assertEqual(checkpoint.recovery.approvalEventType, 'approve-stuck-item-recovery-251-v3', 'recovery approval event type');
	if (!/^[0-9a-f-]{36}$/.test(checkpoint.recovery.approvalToken)) {
		throw new Error('Recovery approval token is invalid');
	}
	if (checkpoint.recovery.approvalTimeoutMs <= 0) throw new Error('Recovery approval timeout is invalid');
	if (checkpoint.recovery.pollTimeoutMs >= 300_000 || checkpoint.recovery.pollTimeoutMs <= 0) {
		throw new Error(`Recovery poll timeout is outside the mutation step: ${checkpoint.recovery.pollTimeoutMs}`);
	}
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function resolveExactOwnedItem(env: CoreEnv): Promise<AiSearchItemInfo> {
	const listed = await env.AI_SEARCH.items.list({
		per_page: 50,
		search: checkpoint.resource.id,
		source: 'builtin',
	});
	const total = listed.result_info?.total_count;
	if (total === undefined || total > 50) throw new Error(`Recovery item lookup returned an unsafe total: ${String(total)}`);
	const matches = listed.result.filter((item) => item.key === checkpoint.item.key && item.source_id === checkpoint.item.sourceId);
	if (matches.length !== 1) throw new Error(`Recovery item lookup returned ${matches.length} exact matches`);
	return matches[0];
}

async function assertPinnedItem(env: CoreEnv): Promise<ItemEvidence & { logCount: number }> {
	const item = await resolveExactOwnedItem(env);
	assertEqual(item.id, checkpoint.item.id, 'pinned item id');
	assertEqual(item.status, checkpoint.item.status, 'pinned item status');
	assertEqual(item.next_action ?? null, null, 'pinned item next action');
	assertEqual(item.last_seen_at, checkpoint.item.lastSeenAt, 'pinned item last seen');
	assertEqual(item.created_at, checkpoint.item.createdAt, 'pinned item created at');
	assertEqual(item.checksum, checkpoint.item.checksum, 'pinned item checksum');
	assertEqual(item.chunks_count, checkpoint.item.chunksCount, 'pinned item chunks');
	assertEqual(item.file_size, checkpoint.item.fileSize, 'pinned item file size');
	assertEqual(item.error ?? null, null, 'pinned item error');
	assertJson(item.metadata, checkpoint.item.metadata, 'pinned item metadata');
	const logs = await env.AI_SEARCH.items.get(item.id).logs({ limit: 100 });
	const pinnedLog = logs.result.some(
		(log) =>
			log.timestamp === checkpoint.itemLog.timestamp &&
			log.action === checkpoint.itemLog.action &&
			log.message === checkpoint.itemLog.message &&
			log.chunkCount === checkpoint.itemLog.chunkCount &&
			(log.errorType ?? null) === null,
	);
	assertEqual(pinnedLog, true, 'pinned item successful log');
	return {
		checksum: item.checksum ?? null,
		chunksCount: item.chunks_count ?? null,
		fileSize: item.file_size ?? null,
		id: item.id,
		key: item.key,
		lastSeenAt: item.last_seen_at ?? null,
		logCount: logs.result.length,
		status: item.status,
	};
}

async function loadDurableState(db: CoreDb): Promise<DurableStateRow> {
	const [row] = await queryRows<DurableStateRow>(
		db,
		sql`
			SELECT index_name,
			       generation,
			       generation_key,
			       status,
			       rebuild_epoch::int,
			       to_char(rebuilding_at AT TIME ZONE 'UTC', ${UTC_TIMESTAMP_FORMAT}) AS rebuilding_at,
			       ready_at IS NULL AS ready_is_null
			FROM search_index_states
			WHERE index_name = ${checkpoint.durableState.indexName}
		`,
	);
	if (!row) throw new Error('Recovery durable state is missing');
	assertJson(
		row,
		{
			generation: checkpoint.durableState.generation,
			generation_key: checkpoint.durableState.generationKey,
			index_name: checkpoint.durableState.indexName,
			ready_is_null: true,
			rebuild_epoch: checkpoint.durableState.rebuildEpoch,
			rebuilding_at: checkpoint.durableState.rebuildingAt,
			status: 'rebuilding',
		},
		'recovery durable state',
	);
	return row;
}

async function loadResourceCheckpoint(db: CoreDb): Promise<ResourceCheckpointRow> {
	const [row] = await queryRows<ResourceCheckpointRow>(
		db,
		sql`
			SELECT r.id::text,
			       r.kind,
			       r.resource_platform,
			       r.scope,
			       r.enrichment_status,
			       r.source_id::text,
			       r.category,
			       r.original_lang,
			       COALESCE(r.published_date, r.scraped_date, r.created_at)::text AS effective_at,
			       r.updated_at::text,
			       MAX(rt.updated_at) FILTER (
			         WHERE rt.lang = r.original_lang OR rt.lang IN ('en', 'zh-Hant')
			       )::text AS latest_translation_updated_at,
			       COUNT(*) FILTER (
			         WHERE rt.lang = r.original_lang OR rt.lang IN ('en', 'zh-Hant')
			       )::int AS indexed_translation_count
			FROM resources r
			LEFT JOIN resource_translations rt ON rt.resource_id = r.id
			WHERE r.id = ${checkpoint.resource.id}::uuid
			GROUP BY r.id
		`,
	);
	if (!row) throw new Error('Recovery resource is missing');
	assertJson(
		row,
		{
			category: checkpoint.resource.category,
			effective_at: checkpoint.resource.effectiveAt,
			enrichment_status: checkpoint.resource.enrichmentStatus,
			id: checkpoint.resource.id,
			indexed_translation_count: checkpoint.resource.indexedTranslationCount,
			kind: checkpoint.resource.kind,
			latest_translation_updated_at: checkpoint.resource.latestTranslationUpdatedAt,
			original_lang: checkpoint.resource.originalLang,
			resource_platform: checkpoint.resource.resourcePlatform,
			scope: checkpoint.resource.scope,
			source_id: checkpoint.resource.sourceId,
			updated_at: checkpoint.resource.updatedAt,
		},
		'recovery resource',
	);
	return row;
}

async function loadCanonicalSnapshot(env: CoreEnv): Promise<CanonicalSnapshot> {
	return withCoreDb(env, async (db) => {
		const durableState = await loadDurableState(db);
		const resource = await loadResourceCheckpoint(db);
		const document = await loadCorpusDocument(db, checkpoint.resource.id);
		if (!document) throw new Error('Recovery canonical corpus document is missing');
		const metadata = corpusItemMetadata(document);
		assertJson(metadata, checkpoint.item.customMetadata, 'recovery canonical metadata');
		const content = serializeDocument(document);
		const contentBytes = new TextEncoder().encode(content).byteLength;
		if (contentBytes <= 0 || contentBytes > 4 * 1024 * 1024) {
			throw new Error(`Recovery canonical content has an unsafe size: ${contentBytes}`);
		}
		return {
			content,
			contentBytes,
			contentSha256: await sha256Hex(content),
			document,
			durableState,
			metadata,
			resource,
		};
	});
}

function canonicalEvidence(snapshot: CanonicalSnapshot): CanonicalEvidence {
	return {
		contentBytes: snapshot.contentBytes,
		contentSha256: snapshot.contentSha256,
		durableState: snapshot.durableState,
		metadata: normalizeCustomMetadata(snapshot.metadata),
		resource: snapshot.resource,
	};
}

async function verifyRecoveryPreflight(env: RecoveryEnv): Promise<RecoveryPreflight> {
	const info = await env.AI_SEARCH.info();
	assertEqual(info.id, checkpoint.aiSearchInstanceName, 'recovery binding id');
	assertEqual(info.paused, false, 'recovery binding paused');
	assertEqual(canonicalSearchInstanceConfigMatches(info), true, 'recovery binding canonical config');
	const item = await assertPinnedItem(env);
	const canonical = await loadCanonicalSnapshot(env);
	return {
		binding: {
			id: info.id,
			paused: false,
			configReady: true,
			workerVersionId: env.CF_VERSION_METADATA.id,
		},
		canonical: canonicalEvidence(canonical),
		item,
	};
}

function assertRecoveredItem(item: AiSearchItemInfo, label: string): void {
	assertEqual(item.key, checkpoint.item.key, `${label} key`);
	assertEqual(item.source_id, checkpoint.item.sourceId, `${label} source`);
	assertEqual(item.status, 'completed', `${label} status`);
	assertEqual(item.error ?? null, null, `${label} error`);
	if (!Number.isSafeInteger(item.chunks_count) || (item.chunks_count ?? 0) <= 0) {
		throw new Error(`${label} has invalid chunks: ${String(item.chunks_count)}`);
	}
	const currentLastSeen = timestampMs(item.last_seen_at);
	const pinnedLastSeen = timestampMs(checkpoint.item.lastSeenAt);
	if (!Number.isFinite(currentLastSeen) || currentLastSeen <= pinnedLastSeen) {
		throw new Error(`${label} did not advance last_seen_at: ${String(item.last_seen_at)}`);
	}
	assertJson(normalizeCustomMetadata(item.metadata), checkpoint.item.customMetadata, `${label} metadata`);
}

function recoveredItemEvidence(item: AiSearchItemInfo): ItemEvidence {
	return {
		checksum: item.checksum ?? null,
		chunksCount: item.chunks_count ?? null,
		fileSize: item.file_size ?? null,
		id: item.id,
		key: item.key,
		lastSeenAt: item.last_seen_at ?? null,
		status: item.status,
	};
}

async function upsertPinnedItem(env: CoreEnv, expectedContentSha256: string): Promise<ItemEvidence> {
	await assertPinnedItem(env);
	const canonical = await loadCanonicalSnapshot(env);
	assertEqual(canonical.contentSha256, expectedContentSha256, 'recovery canonical content remained stable');
	const result = await env.AI_SEARCH.items.uploadAndPoll(itemKey(canonical.document.id), canonical.content, {
		metadata: canonical.metadata,
		pollIntervalMs: checkpoint.recovery.pollIntervalMs,
		timeoutMs: checkpoint.recovery.pollTimeoutMs,
	});
	if (!result || typeof result !== 'object') throw new Error('Recovery uploadAndPoll returned no item');
	assertRecoveredItem(result, 'recovery upload result');
	return recoveredItemEvidence(result);
}

async function verifyRecoveryPostflight(env: CoreEnv): Promise<RecoveryPostflight> {
	const item = await resolveExactOwnedItem(env);
	assertRecoveredItem(item, 'recovery postflight item');
	const logs = await env.AI_SEARCH.items.get(item.id).logs({ limit: 100 });
	const newLogs = logs.result.filter((log) => timestampMs(log.timestamp) > timestampMs(checkpoint.itemLog.timestamp));
	if (newLogs.length === 0) throw new Error('Recovery postflight item has no newer log');
	return {
		item: recoveredItemEvidence(item),
		logCount: logs.result.length,
		newestLogAt: newLogs
			.map((log) => log.timestamp)
			.sort()
			.at(-1)!,
	};
}

validateCheckpoint();

export class SearchIndexStuckItem251RecoveryWorkflow extends WorkflowEntrypoint<RecoveryEnv, RecoveryTrigger> {
	async run(event: WorkflowEvent<RecoveryTrigger>, step: WorkflowStep) {
		if (event.workflowName !== checkpoint.recovery.workflowName || event.instanceId !== checkpoint.recovery.instanceId) {
			throw new Error(`Recovery rejected Workflow identity ${event.workflowName}/${event.instanceId}`);
		}
		assertJson(
			Object.keys(event.payload).sort(),
			['approvalToken', 'selectedWorkerVersionId', 'selectedWorkflowVersionId'],
			'recovery trigger payload fields',
		);
		assertEqual(event.payload.approvalToken, checkpoint.recovery.approvalToken, 'recovery trigger approval token');
		if (
			!/^([0-9a-f-]{36})$/.test(event.payload.selectedWorkerVersionId) ||
			!/^([0-9a-f-]{36})$/.test(event.payload.selectedWorkflowVersionId)
		) {
			throw new Error('Recovery trigger selected versions are invalid');
		}
		assertEqual(this.env.CF_VERSION_METADATA.id, event.payload.selectedWorkerVersionId, 'recovery runtime Worker version');
		const preflight = await step.do('verify-stuck-item-recovery-checkpoint', READ_STEP_OPTIONS, () => verifyRecoveryPreflight(this.env));
		const canonical = preflight.canonical;
		const approval = await step.waitForEvent<RecoveryApproval>('wait-for-stuck-item-recovery-approval', {
			type: checkpoint.recovery.approvalEventType,
			timeout: checkpoint.recovery.approvalTimeoutMs,
		});
		assertEqual(approval.type, checkpoint.recovery.approvalEventType, 'recovery approval event');
		assertEqual(approval.payload.approvalToken, checkpoint.recovery.approvalToken, 'recovery approval token');
		assertEqual(approval.payload.instanceId, event.instanceId, 'recovery approval instance');
		assertEqual(approval.payload.canonicalContentSha256, canonical.contentSha256, 'recovery approval content');
		assertEqual(approval.payload.selectedWorkerVersionId, event.payload.selectedWorkerVersionId, 'recovery approval Worker version');
		assertEqual(approval.payload.selectedWorkflowVersionId, event.payload.selectedWorkflowVersionId, 'recovery approval Workflow version');
		assertEqual(this.env.CF_VERSION_METADATA.id, approval.payload.selectedWorkerVersionId, 'recovery approved runtime Worker version');
		const upsert = await step.do('upsert-stuck-item-from-canonical-corpus', MUTATION_STEP_OPTIONS, () =>
			upsertPinnedItem(this.env, canonical.contentSha256 as string),
		);
		const postflight = await step.do('verify-stuck-item-recovery-result', READ_STEP_OPTIONS, () => verifyRecoveryPostflight(this.env));
		return {
			mode: 'stuck-item-recovery-251' as const,
			approval: {
				canonicalContentSha256: approval.payload.canonicalContentSha256,
				selectedWorkerVersionId: approval.payload.selectedWorkerVersionId,
				selectedWorkflowVersionId: approval.payload.selectedWorkflowVersionId,
			},
			preflight,
			upsert,
			postflight,
		};
	}
}
