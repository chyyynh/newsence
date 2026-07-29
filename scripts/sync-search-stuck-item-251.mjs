import assert from 'node:assert/strict';
import pg from 'pg';
import checkpoint from '../search-stuck-item-251.json' with { type: 'json' };

const APPLY = process.argv.includes('--apply');
const ALLOWED_ARGUMENTS = new Set(['--apply']);
assert.deepEqual(
	process.argv.slice(2).filter((argument) => !ALLOWED_ARGUMENTS.has(argument)),
	[],
	'unknown operator arguments',
);

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

async function cloudflareApi(url, token, label, init = {}) {
	const response = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...init.headers,
		},
	});
	const payload = await response.json();
	assert.equal(response.ok, true, `${label} HTTP ${response.status}: ${JSON.stringify(payload.errors ?? [])}`);
	assert.equal(payload.success, true, `${label} API`);
	return payload.result;
}

function itemUrl(accountId, suffix = '') {
	return (
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/instances/` +
		`${checkpoint.aiSearchInstanceName}/items/${checkpoint.item.id}${suffix}`
	);
}

function assertPinnedItem(item, label) {
	assert.equal(item.id, checkpoint.item.id, `${label} id`);
	assert.equal(item.key, checkpoint.item.key, `${label} key`);
	assert.equal(item.source_id, checkpoint.item.sourceId, `${label} source`);
	assert.equal(item.status, checkpoint.item.status, `${label} status`);
	assert.equal(item.last_seen_at, checkpoint.item.lastSeenAt, `${label} last seen`);
	assert.equal(item.checksum, checkpoint.item.checksum, `${label} checksum`);
	assert.equal(item.chunks_count, checkpoint.item.chunksCount, `${label} chunks`);
	assert.equal(item.error ?? null, null, `${label} error`);
	const normalizedLastSeenAt = `${checkpoint.item.lastSeenAt.replace(' ', 'T')}Z`;
	assert.ok(Date.now() - Date.parse(normalizedLastSeenAt) > 60 * 60 * 1000, `${label} has been running for more than one hour`);
}

function assertPinnedWorkflow(instance) {
	assert.ok(checkpoint.repairWorkflowStatuses.includes(instance.status), `repair Workflow status ${instance.status}`);
	assert.equal(instance.success ?? null, null, 'repair Workflow success');
	assert.equal(instance.error ?? null, null, 'repair Workflow error');
	assert.equal(instance.versionId, checkpoint.repairWorkflowVersionId, 'repair Workflow version');
	assert.equal(instance.step_count, checkpoint.repairWorkflowStepCount, 'repair Workflow step count');
	assert.ok(Array.isArray(instance.steps), 'repair Workflow steps');
	const failedSteps = instance.steps.filter((step) => step.type === 'step' && step.success !== true).map((step) => step.name);
	assert.deepEqual(failedSteps, [], 'repair Workflow failed steps');
	const completedInitialBatchIndexes = instance.steps
		.flatMap((step) => {
			const match = /^apply-search-index-repair-targets-0-(\d+)-1$/.exec(step.name);
			return match && step.success === true ? [Number(match[1])] : [];
		})
		.sort((left, right) => left - right);
	assert.deepEqual(
		completedInitialBatchIndexes,
		Array.from({ length: 17 }, (_, index) => index),
		'repair Workflow initial batch indexes',
	);
	const initialWaitStep = instance.steps.filter((step) => step.name === 'wait-search-index-repair-0-1');
	assert.equal(initialWaitStep.length, 1, 'repair Workflow initial settle step count');
	assert.equal(initialWaitStep[0]?.type, 'sleep', 'repair Workflow initial settle step type');
	assert.equal(initialWaitStep[0]?.finished, true, 'repair Workflow initial settle step finished');
	const readinessStep = instance.steps.filter((step) => step.name === checkpoint.repairReadinessStepName);
	assert.equal(readinessStep.length, 1, 'repair Workflow readiness step count');
	assert.equal(readinessStep[0]?.type, 'step', 'repair Workflow readiness step type');
	assert.equal(readinessStep[0]?.success, true, 'repair Workflow readiness step success');
	assert.equal(typeof readinessStep[0]?.output, 'string', 'repair Workflow readiness step output');
	const readiness = JSON.parse(readinessStep[0].output);
	assert.equal(readiness.configReady, true, 'repair Workflow readiness config');
	assert.equal(readiness.expected?.total, checkpoint.repairReadiness.expectedTotal, 'repair Workflow readiness expected total');
	assert.equal(readiness.indexed ?? null, null, 'repair Workflow readiness indexed observation');
	assert.deepEqual(
		readiness.ownedStatuses,
		{
			completed: checkpoint.repairReadiness.completed,
			error: 0,
			outdated: 0,
			queued: 0,
			running: checkpoint.repairReadiness.running,
			skipped: 0,
		},
		'repair Workflow readiness statuses',
	);
	assert.deepEqual(readiness.stats, readiness.ownedStatuses, 'repair Workflow readiness stats');
	const waitStep = instance.steps.filter((step) => step.name === checkpoint.repairWaitStepName);
	assert.equal(waitStep.length, 1, 'repair Workflow settle step count');
	assert.equal(waitStep[0]?.type, 'sleep', 'repair Workflow settle step type');
	assert.equal(waitStep[0]?.finished, false, 'repair Workflow settle step unfinished');
}

async function loadAndAssertDatabaseCheckpoint() {
	const client = new pg.Client({ connectionString: databaseUrl() });
	await client.connect();
	let durableState;
	let resource;
	try {
		const [stateResult, resourceResult] = await Promise.all([
			client.query(
				`SELECT index_name,
				        generation,
				        generation_key,
				        status,
				        rebuild_epoch::int,
				        ready_at
				   FROM search_index_states
				  WHERE index_name = $1`,
				[checkpoint.durableState.indexName],
			),
			client.query(
				`SELECT id::text,
				        kind,
				        resource_platform,
				        scope,
				        enrichment_status,
				        updated_at::text
				   FROM resources
				  WHERE id = $1::uuid`,
				[checkpoint.resource.id],
			),
		]);
		assert.equal(stateResult.rowCount, 1, 'durable state row');
		assert.equal(resourceResult.rowCount, 1, 'stuck resource row');
		[durableState] = stateResult.rows;
		[resource] = resourceResult.rows;
	} finally {
		await client.end();
	}
	assert.deepEqual(
		durableState,
		{
			generation: checkpoint.durableState.generation,
			generation_key: checkpoint.durableState.generationKey,
			index_name: checkpoint.durableState.indexName,
			ready_at: null,
			rebuild_epoch: checkpoint.durableState.rebuildEpoch,
			status: 'rebuilding',
		},
		'durable repair state',
	);
	assert.deepEqual(
		resource,
		{
			enrichment_status: checkpoint.resource.enrichmentStatus,
			id: checkpoint.resource.id,
			kind: checkpoint.resource.kind,
			resource_platform: checkpoint.resource.resourcePlatform,
			scope: checkpoint.resource.scope,
			updated_at: checkpoint.resource.updatedAt,
		},
		'stuck resource identity',
	);
	return { durableState, resource };
}

const { accountId, aiSearchToken, workflowsToken } = credentials();
const workflowUrl =
	`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/` +
	`${checkpoint.repairWorkflowName}/instances/${checkpoint.repairInstanceId}`;
const [item, logs, workflow] = await Promise.all([
	cloudflareApi(itemUrl(accountId), aiSearchToken, 'stuck item'),
	cloudflareApi(itemUrl(accountId, '/logs'), aiSearchToken, 'stuck item logs'),
	cloudflareApi(workflowUrl, workflowsToken, 'repair Workflow'),
]);
assertPinnedItem(item, 'stuck item');
assert.ok(Array.isArray(logs), 'stuck item logs');
assert.equal(
	logs.some(
		(log) =>
			log.timestamp === checkpoint.itemLog.timestamp &&
			log.action === checkpoint.itemLog.action &&
			log.message === checkpoint.itemLog.message &&
			log.chunkCount === checkpoint.itemLog.chunkCount &&
			log.errorType === null,
	),
	true,
	'stuck item successful reindex log',
);
assertPinnedWorkflow(workflow);

const { durableState } = await loadAndAssertDatabaseCheckpoint();

let synced = null;
if (APPLY) {
	const [currentItem, currentWorkflow] = await Promise.all([
		cloudflareApi(itemUrl(accountId), aiSearchToken, 'stuck item mutation recheck'),
		cloudflareApi(workflowUrl, workflowsToken, 'repair Workflow mutation recheck'),
		loadAndAssertDatabaseCheckpoint(),
	]);
	assertPinnedItem(currentItem, 'stuck item mutation recheck');
	assertPinnedWorkflow(currentWorkflow);
	synced = await cloudflareApi(itemUrl(accountId), aiSearchToken, 'stuck item sync', {
		body: JSON.stringify({ next_action: 'INDEX' }),
		method: 'PATCH',
	});
	assert.equal(synced.id, checkpoint.item.id, 'synced item id');
	assert.equal(synced.key, checkpoint.item.key, 'synced item key');
	assert.equal(synced.source_id, checkpoint.item.sourceId, 'synced item source');
	assert.ok(['queued', 'running', 'completed'].includes(synced.status), `synced item status ${synced.status}`);
	assert.equal(synced.error ?? null, null, 'synced item error');
}

process.stdout.write(
	`${JSON.stringify(
		{
			event: APPLY ? 'search_stuck_item_251_sync_requested' : 'search_stuck_item_251_preflight_validated',
			item: {
				id: item.id,
				key: item.key,
				statusBefore: item.status,
				lastSeenAt: item.last_seen_at,
				chunksCount: item.chunks_count,
			},
			durableState,
			repairWorkflow: {
				name: checkpoint.repairWorkflowName,
				instanceId: checkpoint.repairInstanceId,
				readinessStepName: checkpoint.repairReadinessStepName,
				versionId: workflow.versionId,
				status: workflow.status,
				waitStepName: checkpoint.repairWaitStepName,
			},
			synced,
		},
		null,
		2,
	)}\n`,
);
