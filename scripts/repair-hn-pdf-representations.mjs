import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const WORKFLOW_NAME = 'newsence-resource-processing';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const EXECUTE = process.argv.includes('--execute');
const EXPECTED_COUNT = readIntegerArgument('--expected-count');
const INSTANCE_SUFFIX = readStringArgument('--instance-suffix') ?? 'v1';
const POLL_INTERVAL_MS = Number(process.env.HN_PDF_REPAIR_POLL_INTERVAL_MS ?? 5_000);
const MAX_WAIT_MS = Number(process.env.HN_PDF_REPAIR_MAX_WAIT_MS ?? 20 * 60_000);
assert.ok(Number.isFinite(POLL_INTERVAL_MS) && POLL_INTERVAL_MS > 0, 'HN_PDF_REPAIR_POLL_INTERVAL_MS must be positive');
assert.ok(Number.isFinite(MAX_WAIT_MS) && MAX_WAIT_MS > 0, 'HN_PDF_REPAIR_MAX_WAIT_MS must be positive');

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
	  platform_metadata #>> '{data,storyUrl}' AS story_url
	FROM resources
	WHERE resource_platform = 'hackernews'
	  AND file_type = 'application/pdf'
	  AND (
	    COALESCE(NULLIF(BTRIM(platform_metadata #>> '{representation,fileName}'), ''), '') = ''
	    OR CASE
	      WHEN jsonb_typeof(platform_metadata #> '{representation,fileSize}') = 'number'
	        THEN (platform_metadata #>> '{representation,fileSize}')::numeric <= 0
	      ELSE true
	    END
	  )
	ORDER BY id
`;

function assertRepairCandidate(resource) {
	const discussionUrl = new URL(resource.url);
	assert.equal(discussionUrl.protocol, 'https:', `${resource.id} discussion protocol`);
	assert.equal(discussionUrl.hostname, 'news.ycombinator.com', `${resource.id} discussion host`);
	assert.equal(discussionUrl.pathname, '/item', `${resource.id} discussion path`);
	assert.ok(discussionUrl.searchParams.get('id'), `${resource.id} discussion item id`);

	const storyUrl = new URL(resource.story_url);
	assert.ok(storyUrl.protocol === 'http:' || storyUrl.protocol === 'https:', `${resource.id} story URL protocol`);
}

function runWrangler(arguments_) {
	const result = spawnSync('pnpm', ['exec', 'wrangler', ...arguments_], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-hn-pdf-representation-repair.log',
		},
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Wrangler failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(-2_000)}`);
	}
	return result.stdout.replaceAll(ANSI_ESCAPE, '');
}

function workflowStatus(instanceId) {
	const output = runWrangler(['workflows', 'instances', 'describe', WORKFLOW_NAME, instanceId, '--step-output=false']);
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
	while (Date.now() < deadline) {
		const status = workflowStatus(instanceId);
		if (status === 'complete') return;
		if (status === 'errored' || status === 'terminated' || status === 'paused') {
			throw new Error(`${instanceId} reached terminal status ${status}`);
		}
		await delay(POLL_INTERVAL_MS);
	}
	throw new Error(`${instanceId} did not complete within ${MAX_WAIT_MS}ms`);
}

async function assertRepresentationRepaired(client, resourceId) {
	const result = await client.query(
		`SELECT
		   platform_metadata #>> '{representation,fileName}' AS file_name,
		   platform_metadata #>> '{representation,fileSize}' AS file_size
		 FROM resources
		 WHERE id = $1
		   AND COALESCE(NULLIF(BTRIM(platform_metadata #>> '{representation,fileName}'), ''), '') <> ''
		   AND CASE
		     WHEN jsonb_typeof(platform_metadata #> '{representation,fileSize}') = 'number'
		       THEN (platform_metadata #>> '{representation,fileSize}')::numeric > 0
		     ELSE false
		   END`,
		[resourceId],
	);
	assert.equal(result.rowCount, 1, `${resourceId} repaired representation`);
	return result.rows[0];
}

async function assertSearchGenerationReady(client) {
	const result = await client.query(
		`SELECT generation, generation_key, status, ready_at
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

function repairInstanceId(resourceId) {
	assert.match(INSTANCE_SUFFIX, /^[a-z0-9-]+$/, '--instance-suffix');
	return `issue245-hn-pdf-representation-${resourceId.slice(0, 8)}-${INSTANCE_SUFFIX}`;
}

const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();
try {
	const before = await client.query(missingRepresentationSql);
	for (const resource of before.rows) assertRepairCandidate(resource);

	const plan = before.rows.map((resource) => ({
		instanceId: repairInstanceId(resource.id),
		resourceId: resource.id,
		storyUrl: resource.story_url,
	}));
	console.info(JSON.stringify({ event: 'hn_pdf_representation_repair_plan', execute: EXECUTE, count: plan.length, plan }));

	if (EXECUTE) {
		assert.notEqual(EXPECTED_COUNT, null, '--execute requires --expected-count=N');
		assert.equal(plan.length, EXPECTED_COUNT, 'repair candidate count changed');
		assert.ok(plan.length <= 25, 'refusing to trigger more than 25 repair workflows');
		const searchGeneration = await assertSearchGenerationReady(client);
		console.info(JSON.stringify({ event: 'hn_pdf_representation_repair_preflight', searchGeneration }));

		for (const item of plan) {
			runWrangler([
				'workflows',
				'trigger',
				WORKFLOW_NAME,
				JSON.stringify({ resourceId: item.resourceId, operation: 'resync' }),
				'--id',
				item.instanceId,
			]);
			await waitForWorkflow(item.instanceId);
			const representation = await assertRepresentationRepaired(client, item.resourceId);
			console.info(JSON.stringify({ event: 'hn_pdf_representation_repaired', ...item, ...representation }));
		}

		const after = await client.query(missingRepresentationSql);
		assert.equal(after.rowCount, 0, 'HN PDF representation repair convergence');
		console.info(JSON.stringify({ event: 'hn_pdf_representation_repair_complete', repaired: plan.length, remaining: 0 }));
	}
} finally {
	await client.end();
}
