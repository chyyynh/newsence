import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import checkpoint from '../search-terminal-repair-251.json' with { type: 'json' };

const CAPTURE = process.argv.includes('--capture');
const VERIFY_COMPLETE = process.argv.includes('--verify-complete');
const INDEX_NAME = 'newsence-corpus-v6';
const STATE_INDEX_NAME = 'public-corpus-v6';
const ITEM_PREFIX = 'resources/';
const ITEM_SUFFIX = '.md';
const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

assert.equal(CAPTURE && VERIFY_COMPLETE, false, '--capture and --verify-complete are mutually exclusive');

function credentials() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const aiSearchToken = process.env.CLOUDFLARE_AISEARCH_API_TOKEN?.trim();
	const workflowsToken = process.env.CLOUDFLARE_WORKFLOWS_API_TOKEN?.trim();
	assert.match(accountId ?? '', /^[0-9a-f]{32}$/, 'Set CLOUDFLARE_ACCOUNT_ID');
	assert.ok(aiSearchToken, 'Set CLOUDFLARE_AISEARCH_API_TOKEN');
	assert.ok(workflowsToken, 'Set CLOUDFLARE_WORKFLOWS_API_TOKEN');
	return { accountId, aiSearchToken, workflowsToken };
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	assert.ok(value, 'Set a direct database URL');
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

async function cloudflareApi(url, token, label) {
	const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	const payload = await response.json();
	assert.equal(response.ok, true, `${label} HTTP ${response.status}`);
	assert.equal(payload.success, true, `${label} API`);
	return payload.result;
}

function repairInstanceUrl(accountId) {
	return (
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/` +
		`${checkpoint.repairWorkflowName}/instances/${checkpoint.repairInstanceId}`
	);
}

function repairStepUrl(accountId, step) {
	const url = new URL(`${repairInstanceUrl(accountId)}/step`);
	url.searchParams.set('name', step.name);
	url.searchParams.set('type', step.type);
	return url;
}

async function assertRepairInstanceAbsent() {
	const { accountId, workflowsToken } = credentials();
	const response = await fetch(repairInstanceUrl(accountId), { headers: { Authorization: `Bearer ${workflowsToken}` } });
	const payload = await response.json();
	assert.equal(response.status, 404, `repair runner must not exist before trigger; received HTTP ${response.status}`);
	assert.equal(payload.success, false, 'missing repair runner API response');
}

async function validateFailedRepairAttempt() {
	const { accountId, workflowsToken } = credentials();
	const failed = checkpoint.failedRepairAttempt;
	const url =
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/` + `${failed.workflowName}/instances/${failed.instanceId}`;
	const instance = await cloudflareApi(url, workflowsToken, 'failed repair Workflow instance');
	assert.equal(instance.status, 'errored', 'failed repair status');
	assert.equal(instance.success, false, 'failed repair success');
	assert.equal(instance.error?.name, failed.errorName, 'failed repair error name');
	assert.equal(instance.error?.message, failed.errorMessage, 'failed repair error message');
	assert.equal(instance.step_count, failed.stepCount, 'failed repair step count');
	assert.deepEqual(instance.steps ?? [], [], 'failed repair steps');
}

async function validateRepairConfig() {
	const raw = await readFile(new URL('../wrangler.repair-251.jsonc', import.meta.url), 'utf8');
	const config = JSON.parse(raw);
	assert.equal(config.name, checkpoint.repairWorkerName, 'repair Worker name');
	assert.equal(config.main, 'src/search-terminal-repair-251-entry.ts', 'repair Worker entrypoint');
	assert.equal(config.workers_dev, false, 'repair Worker has no workers.dev route');
	assert.deepEqual(config.routes ?? [], [], 'repair Worker has no routes');
	assert.deepEqual(config.triggers?.crons ?? [], [], 'repair Worker has no crons');
	const repairBinding = config.workflows?.find((binding) => binding.binding === 'SEARCH_INDEX_TERMINAL_REPAIR_251_WORKFLOW');
	assert.equal(repairBinding?.name, checkpoint.repairWorkflowName, 'repair physical Workflow name');
	assert.equal(repairBinding?.class_name, 'SearchIndexTerminalRepair251Workflow', 'repair Workflow class');
	assert.equal(repairBinding?.script_name, undefined, 'repair Workflow is owned by the isolated Worker');
	const failedBinding = config.workflows?.find((binding) => binding.binding === 'SEARCH_INDEX_TERMINAL_REPAIR_251_FAILED_WORKFLOW');
	assert.equal(failedBinding?.name, checkpoint.failedRepairAttempt.workflowName, 'failed repair physical Workflow name');
	assert.equal(failedBinding?.class_name, 'SearchIndexTerminalRepair251Workflow', 'failed repair Workflow class');
	assert.equal(
		config.workflows?.some((binding) => binding.script_name !== undefined),
		false,
		'repair has no external Workflow binding',
	);
	const sourceBinding = config.services?.find((binding) => binding.binding === 'PHASE1_SEARCH_REBUILD_SOURCE_CORE');
	assert.equal(sourceBinding?.service, 'newsence-core', 'source Core service');
	assert.equal(sourceBinding?.entrypoint, undefined, 'source Core default entrypoint');
	const searchBinding = config.ai_search?.find((binding) => binding.binding === 'AI_SEARCH');
	assert.equal(checkpoint.aiSearchInstanceName, INDEX_NAME, 'checkpoint AI Search instance');
	assert.equal(searchBinding?.instance_name, checkpoint.aiSearchInstanceName, 'repair AI Search instance');
	assert.equal(searchBinding?.remote, true, 'repair AI Search binding is remote');
	assert.equal(config.hyperdrive?.length, 1, 'repair Hyperdrive binding count');
	assert.match(checkpoint.repairWorkflowVersionId, /^[0-9a-f-]{36}$/, 'repair pinned Workflow version');
}

async function listStatusItems(status) {
	const { accountId, aiSearchToken } = credentials();
	const items = [];
	let expectedTotal = null;
	for (let page = 1; ; page++) {
		const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/instances/${INDEX_NAME}/items`);
		for (const [key, value] of Object.entries({
			metadata_filter: JSON.stringify({ folder: ITEM_PREFIX }),
			page: String(page),
			per_page: String(PAGE_SIZE),
			sort_by: 'modified_at',
			source: 'builtin',
			status,
		})) {
			url.searchParams.set(key, value);
		}
		const response = await fetch(url, { headers: { Authorization: `Bearer ${aiSearchToken}` } });
		const payload = await response.json();
		assert.equal(response.ok, true, `${status} item page ${page} HTTP ${response.status}`);
		assert.equal(payload.success, true, `${status} item page ${page} API`);
		const total = payload.result_info?.total_count;
		assert.ok(Number.isSafeInteger(total) && total >= 0, `${status} item total`);
		expectedTotal ??= total;
		assert.equal(total, expectedTotal, `${status} item total remained stable`);
		assert.ok(Array.isArray(payload.result), `${status} item result`);
		items.push(...payload.result);
		if (items.length >= total) break;
		assert.ok(payload.result.length > 0, `${status} item paging advanced`);
	}
	assert.equal(items.length, expectedTotal, `${status} item paging complete`);
	return items;
}

function resourceIdFromKey(key) {
	if (typeof key !== 'string' || !key.startsWith(ITEM_PREFIX) || !key.endsWith(ITEM_SUFFIX)) return null;
	const id = key.slice(ITEM_PREFIX.length, -ITEM_SUFFIX.length);
	return UUID.test(id) ? id : null;
}

function compareAscii(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function parseTarget(item, status) {
	assert.equal(item.status, status, `${status} item status`);
	assert.equal(item.source_id, 'builtin', `${status} item source`);
	const resourceId = resourceIdFromKey(item.key);
	assert.ok(resourceId, `${status} item resource key`);
	const error = item.error?.trim() ?? '';
	if (status === 'error') assert.ok(error, `${status} item error`);
	assert.ok(item.id, `${status} item id`);
	assert.ok(item.last_seen_at && Number.isFinite(Date.parse(item.last_seen_at)), `${status} item timestamp`);
	return { error, itemId: item.id, lastSeenAt: item.last_seen_at, resourceId, status };
}

function snapshot(targets) {
	const sortedTargets = [...targets].sort((left, right) => compareAscii(left.resourceId, right.resourceId));
	const digestInput = sortedTargets.map((target) => [target.itemId, target.resourceId, target.status, target.error].join('|')).join('\n');
	return {
		counts: {
			error: sortedTargets.filter((target) => target.status === 'error').length,
			outdated: sortedTargets.filter((target) => target.status === 'outdated').length,
			total: sortedTargets.length,
		},
		digest: createHash('sha256').update(digestInput, 'utf8').digest('hex'),
		targets: sortedTargets,
	};
}

function exactStep(steps, pattern, label) {
	const matches = steps.filter((step) => pattern.test(step.name));
	assert.equal(matches.length, 1, `${label} step count`);
	return matches[0];
}

async function loadFullStepOutput(accountId, workflowsToken, step, label) {
	const result = await cloudflareApi(repairStepUrl(accountId, step), workflowsToken, `${label} full output`);
	assert.equal(result.status, 'complete', `${label} full output status`);
	assert.equal(result.error ?? null, null, `${label} full output error`);
	assert.ok(result.output && typeof result.output === 'object', `${label} full output value`);
	return result.output;
}

function assertReadyObservation(readiness) {
	assert.equal(readiness.configReady, true, 'repair final config');
	for (const status of ['error', 'outdated', 'queued', 'running', 'skipped']) {
		assert.equal(readiness.ownedStatuses?.[status], 0, `repair final ${status} items`);
	}
	assert.equal(readiness.ownedStatuses?.completed, readiness.expected?.total, 'repair final completed count');
	assert.deepEqual(readiness.indexed, readiness.expected, 'repair final identity counts');
}

function assertPinnedSource(source, label) {
	assert.equal(source.workflowName, checkpoint.sourceWorkflowName, `${label} Workflow`);
	assert.equal(source.instanceId, checkpoint.sourceInstanceId, `${label} instance`);
	assert.equal(source.status, 'errored', `${label} status`);
	assert.equal(source.error?.name, checkpoint.sourceErrorName, `${label} error name`);
	assert.match(source.error?.message ?? '', new RegExp(`^${checkpoint.sourceErrorPrefix}`), `${label} error prefix`);
}

async function verifyCompletion() {
	const { accountId, workflowsToken } = credentials();
	const instance = await cloudflareApi(repairInstanceUrl(accountId), workflowsToken, 'repair Workflow instance');
	assert.equal(instance.status, 'complete', 'repair Workflow terminal status');
	assert.equal(instance.success, true, 'repair Workflow success');
	assert.equal(instance.error ?? null, null, 'repair Workflow error');
	assert.equal(instance.versionId, checkpoint.repairWorkflowVersionId, 'repair Workflow remained on pinned version');
	assert.ok(Array.isArray(instance.steps), 'repair Workflow steps');
	const failedSteps = instance.steps.filter((step) => step.type === 'step' && step.success !== true).map((step) => step.name);
	assert.deepEqual(failedSteps, [], 'repair Workflow failed steps');

	const [
		initial,
		bindingBeforeClaim,
		sourceBeforeClaim,
		sourceAfterClaim,
		sourceBeforeReady,
		claim,
		readiness,
		bindingBeforeReady,
		marked,
	] = await Promise.all([
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^snapshot-terminal-search-repair-targets-\d+$/, 'repair initial snapshot'),
			'repair initial snapshot',
		),
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^verify-terminal-repair-search-binding-\d+$/, 'repair initial search binding'),
			'repair initial search binding',
		),
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^verify-phase1-search-rebuild-source-\d+$/, 'repair initial source fence'),
			'repair initial source fence',
		),
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^reverify-phase1-search-rebuild-source-\d+$/, 'repair post-claim source fence'),
			'repair post-claim source fence',
		),
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^final-reverify-phase1-search-rebuild-source-\d+$/, 'repair final source fence'),
			'repair final source fence',
		),
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^claim-terminal-search-repair-lease-\d+$/, 'repair lease claim'),
			'repair lease claim',
		),
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^final-load-terminal-repair-readiness-\d+$/, 'repair final readiness'),
			'repair final readiness',
		),
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^final-reverify-terminal-repair-search-binding-\d+$/, 'repair final search binding'),
			'repair final search binding',
		),
		loadFullStepOutput(
			accountId,
			workflowsToken,
			exactStep(instance.steps, /^mark-terminal-repair-generation-ready-\d+$/, 'repair ready publication'),
			'repair ready publication',
		),
	]);
	assert.deepEqual(initial.counts, checkpoint.initialRepairCounts, 'repair initial counts');
	assert.equal(initial.digest, checkpoint.initialRepairTargetDigest, 'repair initial digest');
	assert.equal(initial.targets?.length, checkpoint.initialRepairCounts.total, 'repair initial target rows');

	assert.deepEqual(
		bindingBeforeClaim,
		{ configReady: true, id: checkpoint.aiSearchInstanceName, paused: false },
		'repair initial search binding',
	);
	assertPinnedSource(sourceBeforeClaim, 'repair initial source');
	assert.deepEqual(sourceAfterClaim, sourceBeforeClaim, 'repair source remained pinned after claim');
	assert.deepEqual(sourceBeforeReady, sourceBeforeClaim, 'repair source remained pinned before ready');

	assert.equal(Number(claim.sourceRebuildEpoch), checkpoint.sourceRebuildEpoch, 'repair source epoch');
	assert.equal(Number(claim.rebuildEpoch), checkpoint.sourceRebuildEpoch + 1, 'repair claimed epoch');
	assert.equal(Number.isNaN(Date.parse(claim.startedAt)), false, 'repair claim timestamp');

	assertReadyObservation(readiness);

	assert.deepEqual(bindingBeforeReady, bindingBeforeClaim, 'repair search binding remained pinned');

	assert.equal(Number.isNaN(Date.parse(marked.readyAt)), false, 'repair ready timestamp');

	const client = new pg.Client({ connectionString: databaseUrl() });
	await client.connect();
	let durableState;
	try {
		const result = await client.query(
			`SELECT index_name,
			        generation,
			        generation_key,
			        status,
			        rebuild_epoch::text,
			        to_char(ready_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ready_at
			   FROM search_index_states
			  WHERE index_name = $1`,
			[STATE_INDEX_NAME],
		);
		assert.equal(result.rowCount, 1, 'durable repair state');
		[durableState] = result.rows;
	} finally {
		await client.end();
	}
	assert.equal(durableState.generation, checkpoint.generation, 'ready durable generation');
	assert.equal(durableState.generation_key, checkpoint.generationKey, 'ready durable generation key');
	assert.equal(durableState.status, 'ready', 'ready durable status');
	assert.equal(Number(durableState.rebuild_epoch), checkpoint.sourceRebuildEpoch + 1, 'ready durable epoch');
	assert.equal(durableState.ready_at, marked.readyAt, 'ready durable timestamp');

	process.stdout.write(
		`${JSON.stringify(
			{
				event: 'search_terminal_repair_251_completion_validated',
				workflowName: checkpoint.repairWorkflowName,
				instanceId: checkpoint.repairInstanceId,
				versionId: instance.versionId,
				status: instance.status,
				claim,
				readiness,
				durableState,
			},
			null,
			2,
		)}\n`,
	);
}

await validateRepairConfig();
await validateFailedRepairAttempt();

if (VERIFY_COMPLETE) {
	await verifyCompletion();
} else {
	await assertRepairInstanceAbsent();
	const [errorItems, outdatedItems] = await Promise.all([listStatusItems('error'), listStatusItems('outdated')]);
	const targetSnapshot = snapshot([
		...errorItems.map((item) => parseTarget(item, 'error')),
		...outdatedItems.map((item) => parseTarget(item, 'outdated')),
	]);
	assert.equal(
		new Set(targetSnapshot.targets.map((target) => target.itemId)).size,
		targetSnapshot.targets.length,
		'unique repair item ids',
	);
	assert.equal(
		new Set(targetSnapshot.targets.map((target) => target.resourceId)).size,
		targetSnapshot.targets.length,
		'unique repair resource ids',
	);

	const client = new pg.Client({ connectionString: databaseUrl() });
	await client.connect();
	let durableState;
	let eligibleCount;
	try {
		const [stateResult, eligibleResult] = await Promise.all([
			client.query(
				`SELECT index_name,
			        generation,
			        generation_key,
			        status,
			        rebuild_epoch::text,
			        ready_at
			   FROM search_index_states
			  WHERE index_name = $1`,
				[STATE_INDEX_NAME],
			),
			client.query(
				`SELECT COUNT(*)::int AS count
			   FROM resources
			  WHERE id = ANY($1::uuid[])
			    AND scope = 'corpus'
			    AND enrichment_status = 'enriched'
			    AND (
			      (kind = 'document' AND resource_platform IS NULL)
			      OR (kind = 'document' AND resource_platform = 'hackernews')
			      OR (kind = 'post' AND resource_platform = 'twitter')
			      OR (kind = 'video' AND resource_platform = 'youtube')
			      OR (kind = 'paper' AND resource_platform IS NULL)
			      OR (kind = 'paper' AND resource_platform = 'hackernews')
			    )`,
				[targetSnapshot.targets.map((target) => target.resourceId)],
			),
		]);
		assert.equal(stateResult.rowCount, 1, 'durable search state');
		[durableState] = stateResult.rows;
		eligibleCount = eligibleResult.rows[0]?.count;
	} finally {
		await client.end();
	}

	const { accountId, workflowsToken } = credentials();
	const sourceUrl =
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/` +
		`${checkpoint.sourceWorkflowName}/instances/${checkpoint.sourceInstanceId}`;
	const source = await cloudflareApi(sourceUrl, workflowsToken, 'source Workflow instance');
	assert.equal(source.status, 'errored', 'source Workflow terminal status');
	assert.equal(source.error?.name, checkpoint.sourceErrorName, 'source Workflow error name');
	assert.match(source.error?.message ?? '', new RegExp(`^${checkpoint.sourceErrorPrefix}`), 'source Workflow error prefix');

	assert.equal(durableState.generation, checkpoint.generation, 'durable generation');
	assert.equal(durableState.generation_key, checkpoint.generationKey, 'durable generation key');
	assert.equal(durableState.status, 'rebuilding', 'durable status');
	assert.equal(Number(durableState.rebuild_epoch), checkpoint.sourceRebuildEpoch, 'durable source rebuild epoch');
	assert.equal(durableState.ready_at, null, 'durable ready timestamp');
	assert.equal(eligibleCount, targetSnapshot.targets.length, 'all repair targets remain eligible');

	if (!CAPTURE) {
		assert.deepEqual(targetSnapshot.counts, checkpoint.initialRepairCounts, 'pinned repair counts');
		assert.equal(targetSnapshot.digest, checkpoint.initialRepairTargetDigest, 'pinned repair digest');
	}

	process.stdout.write(
		`${JSON.stringify(
			{
				event: CAPTURE ? 'search_terminal_repair_251_checkpoint_captured' : 'search_terminal_repair_251_checkpoint_validated',
				source: {
					workflowName: checkpoint.sourceWorkflowName,
					instanceId: checkpoint.sourceInstanceId,
					status: source.status,
					errorName: source.error?.name,
				},
				durableState,
				targets: {
					counts: targetSnapshot.counts,
					digest: targetSnapshot.digest,
					eligibleCount,
				},
			},
			null,
			2,
		)}\n`,
	);
}
