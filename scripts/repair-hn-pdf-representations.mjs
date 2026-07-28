import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const WORKFLOW_NAME = 'newsence-resource-processing';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const EXECUTE = process.argv.includes('--execute');
const EXPECTED_COUNT = readIntegerArgument('--expected-count');
const EXPECTED_PLAN_SHA256 = readStringArgument('--expected-plan-sha256');
const INSTANCE_SUFFIX = readStringArgument('--instance-suffix') ?? 'v1';
const POLL_INTERVAL_MS = Number(process.env.HN_PDF_REPAIR_POLL_INTERVAL_MS ?? 5_000);
const MAX_WAIT_MS = Number(process.env.HN_PDF_REPAIR_MAX_WAIT_MS ?? 20 * 60_000);
const COMMAND_TIMEOUT_MS = Number(process.env.HN_PDF_REPAIR_COMMAND_TIMEOUT_MS ?? 30_000);
assert.ok(Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS > 0, 'HN_PDF_REPAIR_POLL_INTERVAL_MS must be positive');
assert.ok(Number.isFinite(MAX_WAIT_MS) && MAX_WAIT_MS > 0, 'HN_PDF_REPAIR_MAX_WAIT_MS must be positive');
assert.ok(Number.isFinite(COMMAND_TIMEOUT_MS) && COMMAND_TIMEOUT_MS > 0, 'HN_PDF_REPAIR_COMMAND_TIMEOUT_MS must be positive');

function readStringArgument(name) {
	const prefix = `${name}=`;
	return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function readIntegerArgument(name) {
	const value = readStringArgument(name);
	if (value === undefined) return null;
	const parsed = Number(value);
	assert.ok(Number.isSafeInteger(parsed) && parsed >= 0, `${name} must be a non-negative integer`);
	return parsed;
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	if (!value) throw new Error('Set a direct database URL before checking HN PDF representations');
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

const missingRepresentationSql = `
	SELECT
	  id,
	  url,
	  type AS legacy_type,
	  kind,
	  resource_platform,
	  file_type,
	  scope,
	  source_id,
	  enrichment_status,
	  platform_metadata #>> '{data,storyUrl}' AS story_url
	FROM resources
	WHERE resource_platform = 'hackernews'
	  AND file_type = 'application/pdf'
	  AND (
	    jsonb_typeof(platform_metadata #> '{representation,fileName}') IS DISTINCT FROM 'string'
	    OR COALESCE(NULLIF(BTRIM(platform_metadata #>> '{representation,fileName}'), ''), '') = ''
	    OR CASE
	      WHEN jsonb_typeof(platform_metadata #> '{representation,fileSize}') = 'number'
	        THEN (platform_metadata #>> '{representation,fileSize}')::numeric <= 0
	          OR (platform_metadata #>> '{representation,fileSize}')::numeric
	            <> TRUNC((platform_metadata #>> '{representation,fileSize}')::numeric)
	          OR (platform_metadata #>> '{representation,fileSize}')::numeric > 9007199254740991
	      ELSE true
	    END
	  )
	ORDER BY id
`;

function assertRepairCandidate(resource) {
	assert.ok(resource.kind === 'document' || resource.kind === 'paper', `${resource.id} HN PDF kind`);
	assert.equal(resource.resource_platform, 'hackernews', `${resource.id} resource platform`);
	assert.equal(resource.file_type, 'application/pdf', `${resource.id} file type`);
	const discussionUrl = new URL(resource.url);
	assert.equal(discussionUrl.protocol, 'https:', `${resource.id} discussion protocol`);
	assert.equal(discussionUrl.hostname, 'news.ycombinator.com', `${resource.id} discussion host`);
	assert.equal(discussionUrl.pathname, '/item', `${resource.id} discussion path`);
	assert.ok(discussionUrl.searchParams.get('id'), `${resource.id} discussion item id`);

	const storyUrl = new URL(resource.story_url);
	assert.ok(storyUrl.protocol === 'http:' || storyUrl.protocol === 'https:', `${resource.id} story URL protocol`);
}

function spawnWrangler(arguments_) {
	const result = spawnSync('pnpm', ['exec', 'wrangler', ...arguments_], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-hn-pdf-representation-repair.log',
		},
		maxBuffer: 16 * 1024 * 1024,
		timeout: COMMAND_TIMEOUT_MS,
	});
	if (result.error) throw result.error;
	return {
		status: result.status,
		stdout: (result.stdout ?? '').replaceAll(ANSI_ESCAPE, ''),
		stderr: (result.stderr ?? '').replaceAll(ANSI_ESCAPE, ''),
	};
}

function wranglerFailure(result) {
	return new Error(`Wrangler failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(-2_000)}`);
}

function runWrangler(arguments_) {
	const result = spawnWrangler(arguments_);
	if (result.status !== 0) throw wranglerFailure(result);
	return result.stdout;
}

function runSearchRolloutCheck() {
	const result = spawnSync(process.execPath, ['scripts/check-search-rollout.mjs'], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-hn-pdf-representation-repair.log',
		},
		maxBuffer: 16 * 1024 * 1024,
		timeout: COMMAND_TIMEOUT_MS * 2,
	});
	if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? '',
		stderr: result.error?.message ?? result.stderr ?? '',
	};
}

function workflowStatusOrNull(instanceId) {
	const result = spawnWrangler(['workflows', 'instances', 'describe', WORKFLOW_NAME, instanceId, '--step-output=false']);
	if (result.status !== 0) {
		if (`${result.stdout}\n${result.stderr}`.includes('workflows.api.error.instance.not_found')) return null;
		throw wranglerFailure(result);
	}
	const output = result.stdout;
	const header = output.match(/^Status:\s*(.+)$/m)?.[1]?.trim();
	assert.ok(header, `${instanceId} Workflow status`);
	const match = header.match(/\b(queued|running|waiting|paused|errored|terminated|completed?)\b/i);
	assert.ok(match, `${instanceId} normalized Workflow status: ${header}`);
	const status = match[1].toLowerCase();
	return status === 'completed' ? 'complete' : status;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForWorkflow(instanceId) {
	const deadline = Date.now() + MAX_WAIT_MS;
	let consecutiveStatusFailures = 0;
	while (Date.now() < deadline) {
		let status;
		try {
			status = workflowStatusOrNull(instanceId);
			if (status === null) throw new Error(`${instanceId} is not visible yet`);
			consecutiveStatusFailures = 0;
		} catch (error) {
			consecutiveStatusFailures += 1;
			if (consecutiveStatusFailures >= 4) throw error;
			console.warn(
				JSON.stringify({
					event: 'hn_pdf_representation_workflow_status_retry',
					instanceId,
					attempt: consecutiveStatusFailures,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			await delay(POLL_INTERVAL_MS);
			continue;
		}
		if (status === 'complete') return;
		if (status === 'errored' || status === 'terminated' || status === 'paused') {
			throw new Error(`${instanceId} reached terminal status ${status}`);
		}
		await delay(POLL_INTERVAL_MS);
	}
	throw new Error(`${instanceId} did not complete within ${MAX_WAIT_MS}ms`);
}

async function waitForSearchRollout() {
	const deadline = Date.now() + MAX_WAIT_MS;
	let lastFailure = null;
	while (Date.now() < deadline) {
		const result = runSearchRolloutCheck();
		if (result.status === 0) return result.stdout.trim();
		lastFailure = (result.stderr || result.stdout).trim().slice(-2_000);
		console.warn(JSON.stringify({ event: 'hn_pdf_representation_search_rollout_retry', error: lastFailure }));
		await delay(POLL_INTERVAL_MS);
	}
	throw new Error(`Search rollout did not settle after HN PDF repair: ${lastFailure}`);
}

async function loadResourceState(client, resourceId) {
	const result = await client.query(
		`SELECT
		   url,
		   type AS legacy_type,
		   kind,
		   resource_platform,
		   file_type,
		   scope,
		   source_id,
		   enrichment_status,
		   platform_metadata #>> '{data,storyUrl}' AS story_url,
		   jsonb_typeof(platform_metadata #> '{representation,fileName}') AS file_name_type,
		   platform_metadata #>> '{representation,fileName}' AS file_name,
		   jsonb_typeof(platform_metadata #> '{representation,fileSize}') AS file_size_type,
		   platform_metadata #>> '{representation,fileSize}' AS file_size
		 FROM resources
		 WHERE id = $1`,
		[resourceId],
	);
	assert.equal(result.rowCount, 1, `${resourceId} resource row`);
	return result.rows[0];
}

function representationIsComplete(resource) {
	return (
		resource.file_name_type === 'string' &&
		!!resource.file_name?.trim() &&
		resource.file_size_type === 'number' &&
		Number.isSafeInteger(Number(resource.file_size)) &&
		Number(resource.file_size) > 0
	);
}

function assertResourceBoundary(before, after) {
	assert.equal(after.url, before.url, `${before.resourceId} canonical URL`);
	assert.equal(after.legacy_type, before.legacyType, `${before.resourceId} legacy type`);
	assert.equal(after.kind, before.kind, `${before.resourceId} resource kind`);
	assert.equal(after.resource_platform, before.resourcePlatform, `${before.resourceId} resource platform`);
	assert.equal(after.file_type, before.fileType, `${before.resourceId} file type`);
	assert.equal(after.scope, before.scope, `${before.resourceId} scope`);
	assert.equal(after.source_id, before.sourceId, `${before.resourceId} source provenance`);
	assert.equal(after.story_url, before.storyUrl, `${before.resourceId} HN story URL`);
}

function assertRepresentationRepaired(before, after) {
	assertResourceBoundary(before, after);
	assert.equal(after.enrichment_status, 'enriched', `${before.resourceId} enrichment status`);
	assert.ok(representationIsComplete(after), `${before.resourceId} repaired representation`);
	return { fileName: after.file_name, fileSize: Number(after.file_size) };
}

async function assertSearchGenerationReady(client) {
	const result = await client.query(
		`SELECT generation, generation_key, status, rebuild_epoch, ready_at
		 FROM search_index_states
		 WHERE index_name = 'public-corpus'`,
	);
	assert.equal(result.rowCount, 1, 'public-corpus search generation row');
	const [state] = result.rows;
	assert.equal(state.generation, 3, 'search generation');
	assert.equal(state.generation_key, 'canonical-3-kind', 'search generation key');
	assert.equal(state.status, 'ready', 'search generation must be ready before repair');
	assert.ok(state.ready_at, 'search generation ready_at');
	return state;
}

function searchGenerationFence(state) {
	return {
		generation: Number(state.generation),
		generationKey: state.generation_key,
		rebuildEpoch: String(state.rebuild_epoch),
		readyAt: new Date(state.ready_at).toISOString(),
	};
}

function planSha256(plan) {
	const pinnedRows = plan.map(({ instanceId: _instanceId, ...row }) => row);
	return createHash('sha256').update(JSON.stringify(pinnedRows)).digest('hex');
}

function repairInstanceId(resourceId) {
	assert.match(INSTANCE_SUFFIX, /^[a-z0-9-]+$/, '--instance-suffix');
	assert.ok(INSTANCE_SUFFIX.length <= 32, '--instance-suffix must be at most 32 characters');
	return `issue245-hn-pdf-representation-${resourceId}-${INSTANCE_SUFFIX}`;
}

const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();
try {
	const before = await client.query(missingRepresentationSql);
	for (const resource of before.rows) assertRepairCandidate(resource);

	const plan = before.rows.map((resource) => ({
		instanceId: repairInstanceId(resource.id),
		resourceId: resource.id,
		url: resource.url,
		legacyType: resource.legacy_type,
		kind: resource.kind,
		resourcePlatform: resource.resource_platform,
		fileType: resource.file_type,
		scope: resource.scope,
		sourceId: resource.source_id,
		beforeEnrichmentStatus: resource.enrichment_status,
		storyUrl: resource.story_url,
	}));
	assert.equal(new Set(plan.map((item) => item.resourceId)).size, plan.length, 'repair resource IDs must be unique');
	assert.equal(new Set(plan.map((item) => item.instanceId)).size, plan.length, 'repair instance IDs must be unique');
	const sha256 = planSha256(plan);
	console.info(JSON.stringify({ event: 'hn_pdf_representation_repair_plan', execute: EXECUTE, count: plan.length, sha256, plan }));

	if (EXECUTE) {
		assert.notEqual(EXPECTED_COUNT, null, '--execute requires --expected-count=N');
		assert.match(EXPECTED_PLAN_SHA256 ?? '', /^[a-f0-9]{64}$/, '--execute requires --expected-plan-sha256=<64 lowercase hex>');
		assert.equal(plan.length, EXPECTED_COUNT, 'repair candidate count changed');
		assert.equal(sha256, EXPECTED_PLAN_SHA256, 'repair candidate plan changed');
		assert.ok(plan.length <= 25, 'refusing to trigger more than 25 repair workflows');
		const searchGeneration = searchGenerationFence(await assertSearchGenerationReady(client));
		console.info(JSON.stringify({ event: 'hn_pdf_representation_repair_preflight', searchGeneration, sha256 }));

		for (const item of plan) {
			const currentGeneration = searchGenerationFence(await assertSearchGenerationReady(client));
			assert.deepEqual(currentGeneration, searchGeneration, `${item.resourceId} search generation fence`);

			const current = await loadResourceState(client, item.resourceId);
			assertResourceBoundary(item, current);
			if (representationIsComplete(current)) {
				const representation = assertRepresentationRepaired(item, current);
				console.info(JSON.stringify({ event: 'hn_pdf_representation_already_repaired', ...item, ...representation }));
				continue;
			}

			const existingStatus = workflowStatusOrNull(item.instanceId);
			if (existingStatus === null) {
				runWrangler([
					'workflows',
					'trigger',
					WORKFLOW_NAME,
					JSON.stringify({ resourceId: item.resourceId, operation: 'resync' }),
					'--id',
					item.instanceId,
				]);
			} else if (existingStatus === 'errored' || existingStatus === 'terminated' || existingStatus === 'paused') {
				throw new Error(`${item.instanceId} already has terminal status ${existingStatus}; inspect it and use a new instance suffix`);
			}

			if (existingStatus !== 'complete') await waitForWorkflow(item.instanceId);
			const postWorkflowGeneration = searchGenerationFence(await assertSearchGenerationReady(client));
			assert.deepEqual(postWorkflowGeneration, searchGeneration, `${item.resourceId} post-workflow search generation fence`);
			const repaired = await loadResourceState(client, item.resourceId);
			const representation = assertRepresentationRepaired(item, repaired);
			console.info(JSON.stringify({ event: 'hn_pdf_representation_repaired', ...item, ...representation }));
		}

		const rollout = await waitForSearchRollout();
		const finalSearchGeneration = searchGenerationFence(await assertSearchGenerationReady(client));
		assert.deepEqual(finalSearchGeneration, searchGeneration, 'HN PDF repair final search generation fence');
		const after = await client.query(missingRepresentationSql);
		assert.equal(after.rowCount, 0, 'HN PDF representation repair convergence');
		console.info(rollout);
		console.info(
			JSON.stringify({
				event: 'hn_pdf_representation_repair_complete',
				repaired: plan.length,
				remaining: 0,
				searchGeneration,
				sha256,
			}),
		);
	}
} finally {
	await client.end();
}
