import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const WORKFLOW_NAME = 'newsence-search-index-canonical-v6-rebuild';
const DEFAULT_INSTANCE_ID = 'search-index-rebuild-canonical-4-kind-platform-canonical-v1';
const STATE_INDEX_NAME = 'public-corpus-v6';
const GENERATION = 4;
const GENERATION_KEY = 'canonical-4-kind-platform';
const INSTANCE_ID = process.env.SEARCH_REBUILD_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
const ALLOW_IN_PROGRESS = process.argv.includes('--allow-in-progress');
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const NON_FAILURE_STATUSES = new Set(['queued', 'running', 'waiting', 'complete']);

function describeWorkflowInstance() {
	const result = spawnSync('pnpm', ['exec', 'wrangler', 'workflows', 'instances', 'describe', WORKFLOW_NAME, INSTANCE_ID], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-search-rebuild-check.log',
		},
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Workflow describe failed (${result.status}): ${result.stderr.trim().slice(-2000)}`);
	}
	return result.stdout.replaceAll(ANSI_ESCAPE, '');
}

function header(output, label) {
	const value = output.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1]?.trim();
	assert.ok(value, `Workflow describe ${label}`);
	return value;
}

function optionalHeader(output, label) {
	return output.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
}

function normalizedStatus(value) {
	const match = value.match(/\b(queued|running|waiting|paused|errored|terminated|completed?|unknown)\b/i);
	assert.ok(match, `Workflow status: ${value}`);
	return match[1].toLowerCase() === 'completed' ? 'complete' : match[1].toLowerCase();
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	if (!value) throw new Error('Set a direct database URL before search-rebuild validation');
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

const output = describeWorkflowInstance();
const workflowName = header(output, 'Workflow Name');
const instanceId = header(output, 'Instance Id');
const versionId = header(output, 'Version Id');
const status = normalizedStatus(header(output, 'Status'));
const lastSuccessfulStep = header(output, 'Last Successful Step');
const workflowError = optionalHeader(output, 'Error');

assert.equal(workflowName, WORKFLOW_NAME, 'canonical physical Workflow name');
assert.equal(instanceId, INSTANCE_ID, 'Workflow instance id');
assert.ok(NON_FAILURE_STATUSES.has(status), `Workflow entered terminal failure status ${status}: ${workflowError ?? 'no error'}`);
if (!ALLOW_IN_PROGRESS) {
	assert.equal(status, 'complete', 'Workflow terminal completion');
	assert.equal(workflowError, null, 'completed Workflow error');
	assert.match(lastSuccessfulStep, /^mark-canonical-v6-search-index-generation-ready-\d+$/, 'canonical v6 final ready step');
}

const client = new pg.Client({ connectionString: databaseUrl() });
await client.connect();
let durableState;
try {
	const result = await client.query(
		`SELECT generation, generation_key, status, rebuild_epoch, rebuilding_at, ready_at, updated_at
		   FROM search_index_states
		  WHERE index_name = $1`,
		[STATE_INDEX_NAME],
	);
	assert.equal(result.rowCount, 1, 'canonical durable generation row');
	[durableState] = result.rows;
} finally {
	await client.end();
}

assert.equal(durableState.generation, GENERATION, 'durable search generation');
assert.equal(durableState.generation_key, GENERATION_KEY, 'durable search generation key');
assert.ok(Number(durableState.rebuild_epoch) > 0, 'durable generation fencing epoch');
if (!ALLOW_IN_PROGRESS) {
	assert.equal(durableState.status, 'ready', 'durable search readiness');
	assert.ok(durableState.ready_at, 'durable search ready timestamp');
} else {
	assert.ok(['rebuilding', 'ready'].includes(durableState.status), 'durable search rollout status');
}

console.info({
	event: ALLOW_IN_PROGRESS ? 'search_rebuild_progress_validated' : 'search_rebuild_completion_validated',
	workflowName,
	instanceId,
	versionId,
	status,
	workflowError,
	lastSuccessfulStep,
	durableState: {
		generation: durableState.generation,
		generationKey: durableState.generation_key,
		status: durableState.status,
		rebuildEpoch: Number(durableState.rebuild_epoch),
		rebuildingAt: durableState.rebuilding_at,
		readyAt: durableState.ready_at,
		updatedAt: durableState.updated_at,
	},
});
