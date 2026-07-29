import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import checkpoint from '../search-stuck-item-251.json' with { type: 'json' };

const execFileAsync = promisify(execFile);
const CORE_WORKER_DIRECTORY = fileURLToPath(new URL('../', import.meta.url));
const WRANGLER_BINARY = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));
const WRANGLER_CONFIG = 'wrangler.stuck-item-recovery-251.jsonc';
const VERIFY_COMPLETE = process.argv.includes('--verify-complete');
const CAPTURE_VERSION = process.argv.includes('--capture-version');
const TRIGGER = process.argv.includes('--trigger');
assert.ok(Number(VERIFY_COMPLETE) + Number(CAPTURE_VERSION) + Number(TRIGGER) <= 1, 'choose only one operator mode');
const ALLOWED_ARGUMENTS = new Set(['--capture-version', '--trigger', '--verify-complete']);
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

async function cloudflareApi(url, token, label) {
	const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	const payload = await response.json();
	assert.equal(response.ok, true, `${label} HTTP ${response.status}: ${JSON.stringify(payload.errors ?? [])}`);
	assert.equal(payload.success, true, `${label} API`);
	return payload.result;
}

async function wranglerMutation(arguments_, label) {
	const result = await execFileAsync(WRANGLER_BINARY, [...arguments_, '--config', WRANGLER_CONFIG], {
		cwd: CORE_WORKER_DIRECTORY,
		env: {
			...process.env,
			WRANGLER_LOG_PATH: '/tmp/newsence-stuck-item-recovery-251-operator.log',
		},
		maxBuffer: 1024 * 1024,
		timeout: 60_000,
	});
	return { label, stderr: result.stderr.trim(), stdout: result.stdout.trim() };
}

function recoveryInstanceUrl(accountId) {
	return (
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/${checkpoint.recovery.workflowName}/instances/` +
		checkpoint.recovery.instanceId
	);
}

function recoveryWorkflowUrl(accountId) {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/${checkpoint.recovery.workflowName}`;
}

function recoveryVersionsUrl(accountId) {
	const url = new URL(`${recoveryWorkflowUrl(accountId)}/versions`);
	url.searchParams.set('page', '1');
	url.searchParams.set('per_page', '100');
	return url;
}

function recoveryWorkerDeploymentsUrl(accountId) {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${checkpoint.recovery.workerName}/deployments`;
}

function repairInstanceUrl(accountId) {
	return (
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/${checkpoint.repairWorkflowName}/instances/` +
		checkpoint.repairInstanceId
	);
}

function aiSearchItemsUrl(accountId) {
	const url = new URL(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-search/instances/${checkpoint.aiSearchInstanceName}/items`,
	);
	url.searchParams.set('key', checkpoint.item.key);
	url.searchParams.set('source', checkpoint.item.sourceId);
	url.searchParams.set('per_page', '50');
	return url;
}

async function validateConfig() {
	assert.equal(checkpoint.recovery.approvalEventType, 'approve-stuck-item-recovery-251-v2', 'recovery approval event type');
	assert.match(checkpoint.recovery.approvalToken, /^[0-9a-f-]{36}$/, 'recovery approval token');
	assert.equal(checkpoint.recovery.approvalTimeoutMs, 300_000, 'recovery approval timeout');
	if (checkpoint.recovery.versionId !== null) {
		assert.match(checkpoint.recovery.versionId, /^[0-9a-f-]{36}$/, 'recovery checkpoint version id');
	}
	if (checkpoint.recovery.workerVersionId !== null) {
		assert.match(checkpoint.recovery.workerVersionId, /^[0-9a-f-]{36}$/, 'recovery checkpoint Worker version id');
	}
	const raw = await readFile(new URL('../wrangler.stuck-item-recovery-251.jsonc', import.meta.url), 'utf8');
	const config = JSON.parse(raw);
	assert.equal(config.name, checkpoint.recovery.workerName, 'recovery Worker name');
	assert.equal(config.main, 'src/search-stuck-item-recovery-251-entry.ts', 'recovery Worker entrypoint');
	assert.deepEqual(config.version_metadata, { binding: 'CF_VERSION_METADATA' }, 'recovery Worker version metadata');
	assert.equal(config.workers_dev, false, 'recovery Worker has no workers.dev route');
	assert.deepEqual(config.routes ?? [], [], 'recovery Worker has no routes');
	assert.deepEqual(config.triggers?.crons ?? [], [], 'recovery Worker has no crons');
	assert.deepEqual(config.services ?? [], [], 'recovery Worker has no service bindings');
	assert.deepEqual(config.r2_buckets ?? [], [], 'recovery Worker has no R2 bindings');
	assert.equal(config.workflows?.length, 1, 'recovery Workflow binding count');
	assert.deepEqual(
		config.workflows?.[0],
		{
			binding: 'SEARCH_INDEX_STUCK_ITEM_RECOVERY_251_WORKFLOW',
			class_name: 'SearchIndexStuckItem251RecoveryWorkflow',
			name: checkpoint.recovery.workflowName,
		},
		'recovery Workflow binding',
	);
	assert.deepEqual(
		config.ai_search,
		[{ binding: 'AI_SEARCH', instance_name: checkpoint.aiSearchInstanceName, remote: true }],
		'recovery AI Search binding',
	);
	assert.deepEqual(config.hyperdrive, [{ binding: 'HYPERDRIVE', id: '5d7b16cf287e4dcc8b36d43461ccbf5c' }], 'recovery Hyperdrive binding');
}

function assertRepairInstance(instance, allowComplete) {
	assert.equal(instance.versionId, checkpoint.repairWorkflowVersionId, 'repair Workflow remained on pinned version');
	assert.equal(instance.error ?? null, null, 'repair Workflow error');
	assert.ok(Array.isArray(instance.steps), 'repair Workflow steps');
	const failedSteps = instance.steps.filter((step) => step.type === 'step' && step.success !== true).map((step) => step.name);
	assert.deepEqual(failedSteps, [], 'repair Workflow failed steps');
	if (allowComplete && instance.status === 'complete') {
		assert.equal(instance.success, true, 'completed repair Workflow success');
		return;
	}
	assert.ok(['running', 'waiting'].includes(instance.status), `repair Workflow status ${instance.status}`);
	assert.equal(instance.success ?? null, null, 'active repair Workflow success');
	assert.equal(
		instance.steps.some((step) => /^mark-terminal-repair-generation-ready-\d+$/.test(step.name)),
		false,
		'repair Workflow has not published readiness before recovery',
	);
}

function timestampMs(value) {
	if (typeof value === 'number') return value;
	if (typeof value !== 'string') return Number.NaN;
	return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

function normalizeCustomMetadata(metadata) {
	assert.ok(metadata && typeof metadata === 'object', 'item metadata');
	const effectiveAt = timestampMs(metadata.effective_at);
	assert.ok(Number.isFinite(effectiveAt), 'item effective_at metadata');
	return {
		effective_at: new Date(effectiveAt).toISOString(),
		source_id: metadata.source_id,
		category: metadata.category,
		kind: metadata.kind,
		resource_platform: metadata.resource_platform,
	};
}

async function loadExactItem(accountId, aiSearchToken) {
	const payload = await cloudflareApi(aiSearchItemsUrl(accountId), aiSearchToken, 'exact recovery item');
	assert.ok(Array.isArray(payload), 'exact recovery item result');
	const matches = payload.filter((item) => item.key === checkpoint.item.key && item.source_id === checkpoint.item.sourceId);
	assert.equal(matches.length, 1, 'exact recovery item count');
	return matches[0];
}

function assertPinnedItem(item) {
	assert.equal(item.id, checkpoint.item.id, 'pinned item id');
	assert.equal(item.status, checkpoint.item.status, 'pinned item status');
	assert.equal(item.next_action ?? null, null, 'pinned item next action');
	assert.equal(item.last_seen_at, checkpoint.item.lastSeenAt, 'pinned item last seen');
	assert.equal(item.created_at, checkpoint.item.createdAt, 'pinned item created at');
	assert.equal(item.checksum, checkpoint.item.checksum, 'pinned item checksum');
	assert.equal(item.chunks_count, checkpoint.item.chunksCount, 'pinned item chunks');
	assert.equal(item.file_size, checkpoint.item.fileSize, 'pinned item file size');
	assert.equal(item.error ?? null, null, 'pinned item error');
	assert.deepEqual(item.metadata, checkpoint.item.metadata, 'pinned item metadata');
}

function assertRecoveredItem(item, label) {
	assert.equal(item.key, checkpoint.item.key, `${label} key`);
	assert.equal(item.source_id, checkpoint.item.sourceId, `${label} source`);
	assert.equal(item.status, 'completed', `${label} status`);
	assert.equal(item.error ?? null, null, `${label} error`);
	assert.ok(Number.isSafeInteger(item.chunks_count) && item.chunks_count > 0, `${label} chunks`);
	assert.ok(timestampMs(item.last_seen_at) > timestampMs(checkpoint.item.lastSeenAt), `${label} last seen advanced`);
	assert.deepEqual(normalizeCustomMetadata(item.metadata), checkpoint.item.customMetadata, `${label} metadata`);
}

async function loadDatabaseCheckpoint() {
	const client = new pg.Client({ connectionString: databaseUrl() });
	await client.connect();
	try {
		const [stateResult, resourceResult] = await Promise.all([
			client.query(
				`SELECT index_name,
				        generation,
				        generation_key,
				        status,
				        rebuild_epoch::int,
				        to_char(rebuilding_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS rebuilding_at,
				        ready_at
				   FROM search_index_states
				  WHERE index_name = $1`,
				[checkpoint.durableState.indexName],
			),
			client.query(
				`SELECT r.id::text,
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
				  WHERE r.id = $1::uuid
				  GROUP BY r.id`,
				[checkpoint.resource.id],
			),
		]);
		assert.equal(stateResult.rowCount, 1, 'recovery durable state row');
		assert.equal(resourceResult.rowCount, 1, 'recovery resource row');
		return { durableState: stateResult.rows[0], resource: resourceResult.rows[0] };
	} finally {
		await client.end();
	}
}

function assertResourceCheckpoint(resource) {
	assert.deepEqual(
		resource,
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
		'recovery resource checkpoint',
	);
}

function assertDurableCheckpoint(durableState, allowReady) {
	assert.equal(durableState.index_name, checkpoint.durableState.indexName, 'recovery durable index');
	assert.equal(durableState.generation, checkpoint.durableState.generation, 'recovery durable generation');
	assert.equal(durableState.generation_key, checkpoint.durableState.generationKey, 'recovery durable generation key');
	assert.equal(durableState.rebuild_epoch, checkpoint.durableState.rebuildEpoch, 'recovery durable epoch');
	assert.equal(durableState.rebuilding_at, checkpoint.durableState.rebuildingAt, 'recovery durable rebuilding timestamp');
	if (allowReady && durableState.status === 'ready') {
		assert.ok(durableState.ready_at, 'ready durable timestamp');
		return;
	}
	assert.equal(durableState.status, 'rebuilding', 'recovery durable status');
	assert.equal(durableState.ready_at, null, 'recovery durable ready timestamp');
}

function exactStep(steps, pattern, label) {
	const matches = steps.filter((step) => pattern.test(step.name));
	assert.equal(matches.length, 1, `${label} step count`);
	return matches[0];
}

function parseStepOutput(step, label) {
	assert.equal(typeof step.output, 'string', `${label} output`);
	return JSON.parse(step.output);
}

async function assertRecoveryRunnerAbsent(accountId, workflowsToken) {
	const response = await fetch(recoveryInstanceUrl(accountId), {
		headers: { Authorization: `Bearer ${workflowsToken}` },
	});
	const payload = await response.json();
	assert.equal(response.status, 404, `recovery runner must not exist; received HTTP ${response.status}`);
	assert.equal(payload.success, false, 'missing recovery runner API response');
}

async function assertRecoveryDeploymentAbsent(accountId, workflowsToken) {
	assert.equal(checkpoint.recovery.versionId, null, 'undeployed recovery checkpoint version');
	assert.equal(checkpoint.recovery.workerVersionId, null, 'undeployed recovery checkpoint Worker version');
	const response = await fetch(recoveryWorkflowUrl(accountId), {
		headers: { Authorization: `Bearer ${workflowsToken}` },
	});
	const payload = await response.json();
	assert.equal(response.status, 404, `recovery Workflow must not be deployed; received HTTP ${response.status}`);
	assert.equal(payload.success, false, 'missing recovery Workflow API response');
	const workerResponse = await fetch(recoveryWorkerDeploymentsUrl(accountId), {
		headers: { Authorization: `Bearer ${workflowsToken}` },
	});
	const workerPayload = await workerResponse.json();
	assert.equal(workerResponse.status, 404, `recovery Worker must not be deployed; received HTTP ${workerResponse.status}`);
	assert.equal(workerPayload.success, false, 'missing recovery Worker API response');
}

async function loadRecoveryDeployment(accountId, workflowsToken) {
	const workflow = await cloudflareApi(recoveryWorkflowUrl(accountId), workflowsToken, 'recovery Workflow deployment');
	assert.equal(workflow.name, checkpoint.recovery.workflowName, 'recovery deployed Workflow name');
	assert.equal(workflow.class_name, 'SearchIndexStuckItem251RecoveryWorkflow', 'recovery deployed Workflow class');
	assert.equal(workflow.script_name, checkpoint.recovery.workerName, 'recovery deployed Worker name');

	const response = await fetch(recoveryVersionsUrl(accountId), {
		headers: { Authorization: `Bearer ${workflowsToken}` },
	});
	const payload = await response.json();
	assert.equal(response.ok, true, `recovery Workflow versions HTTP ${response.status}: ${JSON.stringify(payload.errors ?? [])}`);
	assert.equal(payload.success, true, 'recovery Workflow versions API');
	assert.ok(Array.isArray(payload.result), 'recovery Workflow versions result');
	assert.equal(payload.result_info?.total_count, 1, 'recovery Workflow must have exactly one deployed version');
	assert.equal(payload.result.length, 1, 'recovery Workflow version page count');
	const version = payload.result[0];
	assert.match(version.id ?? '', /^[0-9a-f-]{36}$/, 'recovery deployed Workflow version id');
	assert.equal(version.workflow_id, workflow.id, 'recovery deployed Workflow version owner');
	assert.equal(version.class_name, 'SearchIndexStuckItem251RecoveryWorkflow', 'recovery deployed Workflow version class');
	assert.equal(version.language, 'javascript', 'recovery deployed Workflow language');
	const workerResult = await cloudflareApi(recoveryWorkerDeploymentsUrl(accountId), workflowsToken, 'recovery Worker deployments');
	assert.ok(Array.isArray(workerResult.deployments), 'recovery Worker deployments result');
	assert.equal(workerResult.deployments.length, 1, 'recovery Worker must have exactly one deployment');
	const workerDeployment = workerResult.deployments[0];
	assert.equal(workerDeployment.versions?.length, 1, 'recovery Worker deployment version count');
	const workerVersion = workerDeployment.versions[0];
	assert.equal(workerVersion.percentage, 100, 'recovery Worker deployment percentage');
	assert.match(workerVersion.version_id ?? '', /^[0-9a-f-]{36}$/, 'recovery Worker deployed version id');
	return { version, workerDeployment, workerVersion, workflow };
}

async function assertPinnedRecoveryDeployment(accountId, workflowsToken) {
	assert.match(checkpoint.recovery.versionId ?? '', /^[0-9a-f-]{36}$/, 'pinned recovery Workflow version id');
	assert.match(checkpoint.recovery.workerVersionId ?? '', /^[0-9a-f-]{36}$/, 'pinned recovery Worker version id');
	const deployment = await loadRecoveryDeployment(accountId, workflowsToken);
	assert.equal(deployment.version.id, checkpoint.recovery.versionId, 'recovery Workflow remained on pinned version');
	assert.equal(deployment.workerVersion.version_id, checkpoint.recovery.workerVersionId, 'recovery Worker remained on pinned version');
	return deployment;
}

function sleep(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function terminateRecoveryInstance(accountId, workflowsToken, label) {
	await wranglerMutation(['workflows', 'instances', 'terminate', checkpoint.recovery.workflowName, checkpoint.recovery.instanceId], label);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const instance = await cloudflareApi(recoveryInstanceUrl(accountId), workflowsToken, `${label} confirmation`);
		if (instance.status === 'terminated') return instance;
		assert.ok(['queued', 'running', 'waiting', 'waitingForPause'].includes(instance.status), `${label} status ${instance.status}`);
		await sleep(1_000);
	}
	throw new Error(`${label} did not reach terminated within 30 seconds`);
}

async function createRecoveryInstance() {
	const params = JSON.stringify({
		approvalToken: checkpoint.recovery.approvalToken,
		selectedWorkerVersionId: checkpoint.recovery.workerVersionId,
		selectedWorkflowVersionId: checkpoint.recovery.versionId,
	});
	const result = await wranglerMutation(
		['workflows', 'trigger', checkpoint.recovery.workflowName, params, '--id', checkpoint.recovery.instanceId],
		'recovery Workflow trigger',
	);
	assert.match(result.stdout, /has been queued successfully/, 'recovery Workflow trigger acknowledgement');
	return {
		id: checkpoint.recovery.instanceId,
		status: 'queued',
	};
}

function optionalExactStep(steps, pattern, label) {
	const matches = steps.filter((step) => pattern.test(step.name));
	assert.ok(matches.length <= 1, `${label} step count ${matches.length}`);
	return matches[0] ?? null;
}

async function waitForRecoveryApprovalGate(accountId, workflowsToken) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const instance = await cloudflareApi(recoveryInstanceUrl(accountId), workflowsToken, 'recovery approval gate');
		assert.equal(instance.versionId, checkpoint.recovery.versionId, 'approval gate recovery version');
		assert.equal(instance.error ?? null, null, 'approval gate recovery error');
		assert.ok(Array.isArray(instance.steps), 'approval gate recovery steps');
		assert.equal(
			instance.steps.some((step) => /^upsert-stuck-item-from-canonical-corpus-\d+$/.test(step.name)),
			false,
			'recovery mutation must not start before approval',
		);
		const preflightStep = optionalExactStep(instance.steps, /^verify-stuck-item-recovery-checkpoint-\d+$/, 'recovery approval preflight');
		const approvalStep = optionalExactStep(instance.steps, /^wait-for-stuck-item-recovery-approval-\d+$/, 'recovery approval wait');
		if (preflightStep && approvalStep) {
			assert.equal(approvalStep.type, 'waitForEvent', 'recovery approval gate step type');
			assert.equal(approvalStep.success ?? null, null, 'recovery approval gate remains unresolved');
			assert.equal(preflightStep.success, true, 'recovery approval preflight success');
			const preflight = parseStepOutput(preflightStep, 'recovery approval preflight');
			assert.match(preflight.canonical?.contentSha256 ?? '', /^[0-9a-f]{64}$/, 'recovery approval content digest');
			assert.deepEqual(preflight.canonical?.metadata, checkpoint.item.customMetadata, 'recovery approval metadata');
			assert.equal(preflight.binding?.workerVersionId, checkpoint.recovery.workerVersionId, 'recovery approval runtime Worker version');
			return { instance, preflight };
		}
		assert.ok(['queued', 'running', 'waiting'].includes(instance.status), `recovery approval gate status ${instance.status}`);
		await sleep(2_000);
	}
	throw new Error('Recovery Workflow did not reach its approval gate within 60 seconds');
}

async function triggerPinnedRecovery(accountId, workflowsToken, deployment) {
	assert.equal(deployment.workflow.name, checkpoint.recovery.workflowName, 'trigger pinned Workflow name');
	const created = await createRecoveryInstance();
	let gate;
	try {
		gate = await waitForRecoveryApprovalGate(accountId, workflowsToken);
		await assertPinnedRecoveryDeployment(accountId, workflowsToken);
	} catch (error) {
		await terminateRecoveryInstance(accountId, workflowsToken, 'unapproved recovery Workflow termination');
		throw error;
	}
	const approval = {
		approvalToken: checkpoint.recovery.approvalToken,
		canonicalContentSha256: gate.preflight.canonical.contentSha256,
		instanceId: checkpoint.recovery.instanceId,
		selectedWorkerVersionId: checkpoint.recovery.workerVersionId,
		selectedWorkflowVersionId: checkpoint.recovery.versionId,
	};
	const approvalResult = await wranglerMutation(
		[
			'workflows',
			'instances',
			'send-event',
			checkpoint.recovery.workflowName,
			checkpoint.recovery.instanceId,
			'--type',
			checkpoint.recovery.approvalEventType,
			'--payload',
			JSON.stringify(approval),
		],
		'recovery Workflow approval',
	);
	assert.match(approvalResult.stdout, /was sent to the instance/, 'recovery Workflow approval acknowledgement');
	return { approval, created, gate: gate.instance };
}

async function verifyRecoveryComplete(accountId, workflowsToken, aiSearchToken) {
	const instance = await cloudflareApi(recoveryInstanceUrl(accountId), workflowsToken, 'recovery Workflow');
	assert.equal(instance.status, 'complete', 'recovery Workflow status');
	assert.equal(instance.success, true, 'recovery Workflow success');
	assert.equal(instance.error ?? null, null, 'recovery Workflow error');
	assert.equal(instance.step_count, 4, 'recovery Workflow step count');
	assert.equal(instance.versionId, checkpoint.recovery.versionId, 'recovery Workflow ran the pinned version');
	const failedSteps = instance.steps.filter((step) => step.type === 'step' && step.success !== true).map((step) => step.name);
	assert.deepEqual(failedSteps, [], 'recovery Workflow failed steps');
	const preflight = parseStepOutput(
		exactStep(instance.steps, /^verify-stuck-item-recovery-checkpoint-\d+$/, 'recovery preflight'),
		'recovery preflight',
	);
	const approval = parseStepOutput(
		exactStep(instance.steps, /^wait-for-stuck-item-recovery-approval-\d+$/, 'recovery approval'),
		'recovery approval',
	);
	const upsert = parseStepOutput(
		exactStep(instance.steps, /^upsert-stuck-item-from-canonical-corpus-\d+$/, 'recovery upsert'),
		'recovery upsert',
	);
	const postflight = parseStepOutput(
		exactStep(instance.steps, /^verify-stuck-item-recovery-result-\d+$/, 'recovery postflight'),
		'recovery postflight',
	);
	assert.match(preflight.canonical?.contentSha256 ?? '', /^[0-9a-f]{64}$/, 'recovery canonical content digest');
	assert.ok(preflight.canonical?.contentBytes > 0, 'recovery canonical content bytes');
	assert.deepEqual(preflight.canonical?.metadata, checkpoint.item.customMetadata, 'recovery preflight metadata');
	assert.equal(preflight.binding?.workerVersionId, checkpoint.recovery.workerVersionId, 'recovery preflight runtime Worker version');
	assert.equal(approval.type, checkpoint.recovery.approvalEventType, 'recovery approval event');
	assert.equal(approval.payload?.approvalToken, checkpoint.recovery.approvalToken, 'recovery approval token');
	assert.equal(approval.payload?.instanceId, checkpoint.recovery.instanceId, 'recovery approval instance');
	assert.equal(approval.payload?.selectedWorkerVersionId, checkpoint.recovery.workerVersionId, 'recovery approval Worker version');
	assert.equal(approval.payload?.selectedWorkflowVersionId, checkpoint.recovery.versionId, 'recovery approval Workflow version');
	assert.equal(approval.payload?.canonicalContentSha256, preflight.canonical.contentSha256, 'recovery approval content digest');
	assert.equal(upsert.status, 'completed', 'recovery upsert output status');
	assert.equal(postflight.item?.status, 'completed', 'recovery postflight output status');
	assert.ok(postflight.newestLogAt, 'recovery postflight newest log');
	const item = await loadExactItem(accountId, aiSearchToken);
	assertRecoveredItem(item, 'recovered item');
	return { approval, instance, item, postflight, preflight, upsert };
}

await validateConfig();
const { accountId, aiSearchToken, workflowsToken } = credentials();
const repair = await cloudflareApi(repairInstanceUrl(accountId), workflowsToken, 'repair Workflow');
assertRepairInstance(repair, VERIFY_COMPLETE);
const database = await loadDatabaseCheckpoint();
assertResourceCheckpoint(database.resource);
assertDurableCheckpoint(database.durableState, VERIFY_COMPLETE);

if (VERIFY_COMPLETE) {
	const deployment = await assertPinnedRecoveryDeployment(accountId, workflowsToken);
	const recovery = await verifyRecoveryComplete(accountId, workflowsToken, aiSearchToken);
	process.stdout.write(
		`${JSON.stringify(
			{
				event: 'search_stuck_item_recovery_251_completion_validated',
				recoveryWorkflow: {
					deployedAt: deployment.version.created_on,
					instanceId: checkpoint.recovery.instanceId,
					status: recovery.instance.status,
					versionId: recovery.instance.versionId,
					workerVersionId: deployment.workerVersion.version_id,
					workflowName: checkpoint.recovery.workflowName,
				},
				item: {
					chunksCount: recovery.item.chunks_count,
					id: recovery.item.id,
					key: recovery.item.key,
					lastSeenAt: recovery.item.last_seen_at,
					status: recovery.item.status,
				},
				durableState: database.durableState,
				repairWorkflow: {
					status: repair.status,
					versionId: repair.versionId,
				},
			},
			null,
			2,
		)}\n`,
	);
} else {
	await assertRecoveryRunnerAbsent(accountId, workflowsToken);
	const item = await loadExactItem(accountId, aiSearchToken);
	assertPinnedItem(item);
	let deployment = null;
	if (CAPTURE_VERSION) {
		assert.equal(checkpoint.recovery.versionId, null, 'capture requires an unpinned recovery Workflow checkpoint');
		assert.equal(checkpoint.recovery.workerVersionId, null, 'capture requires an unpinned recovery Worker checkpoint');
		deployment = await loadRecoveryDeployment(accountId, workflowsToken);
	} else if (checkpoint.recovery.versionId === null) {
		await assertRecoveryDeploymentAbsent(accountId, workflowsToken);
	} else {
		deployment = await assertPinnedRecoveryDeployment(accountId, workflowsToken);
	}
	let trigger = null;
	if (TRIGGER) {
		assert.ok(deployment, 'trigger requires the pinned recovery deployment');
		trigger = await triggerPinnedRecovery(accountId, workflowsToken, deployment);
	}
	let event = 'search_stuck_item_recovery_251_preflight_validated';
	if (CAPTURE_VERSION) event = 'search_stuck_item_recovery_251_version_discovered';
	if (TRIGGER) event = 'search_stuck_item_recovery_251_trigger_approved';
	process.stdout.write(
		`${JSON.stringify(
			{
				event,
				recoveryWorkflow: {
					approvalSent: trigger !== null,
					createdStatus: trigger?.created.status ?? null,
					deployedAt: deployment?.version.created_on ?? null,
					instanceId: checkpoint.recovery.instanceId,
					status: trigger ? 'approved' : 'absent',
					versionId: deployment?.version.id ?? null,
					workerVersionId: deployment?.workerVersion.version_id ?? null,
					workflowName: checkpoint.recovery.workflowName,
				},
				item: {
					id: item.id,
					key: item.key,
					lastSeenAt: item.last_seen_at,
					status: item.status,
				},
				durableState: database.durableState,
				repairWorkflow: {
					status: repair.status,
					versionId: repair.versionId,
				},
			},
			null,
			2,
		)}\n`,
	);
}
