import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const WORKFLOW_NAME = 'newsence-search-index-rebuild';
const DEFAULT_INSTANCE_ID = 'search-index-rebuild-canonical-3-kind';
const RESUME_INSTANCE_ID = 'search-index-rebuild-canonical-3-kind-resume-v1';
const LEGACY_BRIDGE_VERSION_ID = '7832da37-1ad4-4ea3-a7f6-1c6e9ead590f';
const RESUME_STARTED_AT = '2026-07-28T05:31:32.516Z';
const INSTANCE_ID = process.env.SEARCH_REBUILD_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
const ALLOW_IN_PROGRESS = process.argv.includes('--allow-in-progress');
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const NON_FAILURE_STATUSES = new Set(['queued', 'running', 'waiting', 'complete']);

function describeWorkflowInstance() {
	const result = spawnSync(
		'pnpm',
		['exec', 'wrangler', 'workflows', 'instances', 'describe', WORKFLOW_NAME, INSTANCE_ID, '--truncate-output-limit', '2000'],
		{
			cwd: PACKAGE_ROOT,
			encoding: 'utf8',
			env: {
				...process.env,
				WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-search-rebuild-check.log',
			},
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Workflow describe failed (${result.status}): ${result.stderr.trim().slice(-2000)}`);
	}
	return result.stdout.replaceAll(ANSI_ESCAPE, '');
}

function header(output, label) {
	const match = output.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
	assert.ok(match, `Workflow describe ${label}`);
	return match[1].trim();
}

function normalizedStatus(value) {
	const match = value.match(/\b(queued|running|waiting|paused|errored|terminated|completed?|unknown)\b/i);
	assert.ok(match, `Workflow status: ${value}`);
	const status = match[1].toLowerCase();
	return status === 'completed' ? 'complete' : status;
}

function workflowSteps(output) {
	const steps = [];
	for (const block of output.split(/\n(?=\s+Name:\s+)/)) {
		const name = block.match(/^\s+Name:\s+(.+)$/m)?.[1]?.trim();
		const success = block.match(/^\s+Success:\s+(.+)$/m)?.[1]?.trim();
		if (!name || !success) continue;
		const attempts = [];
		for (const line of block.split('\n')) {
			if (!line.trimStart().startsWith('│')) continue;
			const cells = line
				.split('│')
				.slice(1, -1)
				.map((cell) => cell.trim());
			if (cells.length < 4 || cells[0] === 'Start' || !/(?:Error|Success|Running)/i.test(cells[3])) continue;
			attempts.push({
				state: cells[3].replaceAll(/[^\p{L}]/gu, '').toLowerCase(),
				error: cells[4] || null,
			});
		}
		steps.push({
			name,
			success,
			output: block.match(/^\s+Output:\s+(.+)$/m)?.[1]?.trim() ?? null,
			retriesAt: block.match(/^\s+Retries At:\s+(.+)$/m)?.[1]?.trim() ?? null,
			attempts,
		});
	}
	return steps;
}

function retrySummary(step) {
	if (!step) return null;
	const failedAttempts = step.attempts.filter((attempt) => attempt.state === 'error');
	const latestAttempt = step.attempts.at(-1) ?? null;
	return {
		step: step.name,
		attemptCount: step.attempts.length,
		failedAttemptCount: failedAttempts.length,
		latestAttemptState: latestAttempt?.state ?? null,
		latestAttemptError: latestAttempt?.error ?? null,
		retriesAt: step.retriesAt,
	};
}

function parsedStepOutput(step, label) {
	assert.ok(step, `${label} step`);
	assert.ok(step.output, `${label} output`);
	let parsed = JSON.parse(step.output);
	if (typeof parsed === 'string' && /^[{[]/.test(parsed.trim())) parsed = JSON.parse(parsed);
	return parsed;
}

function assertResumeCompletion(steps, versionId, lastSuccessfulStep) {
	assert.notEqual(versionId, LEGACY_BRIDGE_VERSION_ID, 'resume Workflow version must not reuse the legacy bridge');
	assert.match(lastSuccessfulStep, /^mark-search-index-generation-ready-\d+$/, 'resume final ready step');
	assert.equal(
		steps.some((step) => /^sync-corpus-page-0-\d+$/.test(step.name)),
		false,
		'resume must not restart at corpus page 0',
	);
	assert.ok(
		steps.some((step) => /^sync-corpus-page-365-\d+$/.test(step.name)),
		'resume corpus page 365',
	);

	const source = parsedStepOutput(
		steps.find((step) => /^verify-errored-search-rebuild-source-\d+$/.test(step.name)),
		'resume source verification',
	);
	assert.equal(source.status, 'errored', 'resume source terminal status');

	const startedAt = parsedStepOutput(
		steps.find((step) => /^capture-search-rebuild-started-at-\d+$/.test(step.name)),
		'resume delta boundary',
	);
	assert.equal(startedAt, RESUME_STARTED_AT, 'resume original delta boundary');

	const lease = parsedStepOutput(
		steps.find((step) => /^begin-search-index-generation-\d+$/.test(step.name)),
		'resume generation lease',
	);
	assert.ok(Number.isSafeInteger(Number(lease.rebuildEpoch)), 'resume generation epoch');

	const readiness = parsedStepOutput(
		steps.findLast((step) => /^load-search-index-readiness-\d+-\d+$/.test(step.name)),
		'resume terminal readiness',
	);
	assert.equal(readiness.configReady, true, 'resume AI Search metadata config');
	assert.deepEqual(readiness.indexed, readiness.expected, 'resume indexed counts by kind');
	assert.equal(readiness.ownedStatuses.completed, readiness.expected.total, 'resume completed owned items');
	for (const state of ['queued', 'running', 'error', 'outdated', 'skipped']) {
		assert.equal(readiness.ownedStatuses[state], 0, `resume owned ${state} items`);
	}

	const generationReadiness = parsedStepOutput(
		steps.find((step) => /^mark-search-index-generation-ready-\d+$/.test(step.name)),
		'resume generation readiness',
	);
	assert.ok(generationReadiness.readyAt, 'resume generation ready timestamp');
	return {
		source,
		startedAt,
		rebuildEpoch: Number(lease.rebuildEpoch),
		readiness,
		generationReadiness,
	};
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	if (!value) throw new Error('Set a direct database URL before strict resume validation');
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

async function assertResumeDurableState(resumeEvidence) {
	const client = new pg.Client({ connectionString: databaseUrl() });
	await client.connect();
	try {
		const result = await client.query(
			`SELECT generation, generation_key, status, rebuild_epoch, ready_at
			   FROM search_index_states
			  WHERE index_name = 'public-corpus'`,
		);
		assert.equal(result.rowCount, 1, 'resume durable generation row');
		const [state] = result.rows;
		assert.equal(state.generation, 3, 'resume durable generation');
		assert.equal(state.generation_key, 'canonical-3-kind', 'resume durable generation key');
		assert.equal(state.status, 'ready', 'resume durable generation status');
		assert.ok(state.ready_at, 'resume durable ready timestamp');
		assert.equal(Number(state.rebuild_epoch), resumeEvidence.rebuildEpoch, 'resume Workflow/database epoch');
		return {
			generation: state.generation,
			generationKey: state.generation_key,
			status: state.status,
			rebuildEpoch: Number(state.rebuild_epoch),
			readyAt: state.ready_at,
		};
	} finally {
		await client.end();
	}
}

const output = describeWorkflowInstance();
const workflowName = header(output, 'Workflow Name');
const instanceId = header(output, 'Instance Id');
const versionId = header(output, 'Version Id');
const status = normalizedStatus(header(output, 'Status'));
const lastSuccessfulStep = header(output, 'Last Successful Step');
const steps = workflowSteps(output);
const failedSteps = steps.filter((step) => /\bNo\b/i.test(step.success)).map((step) => step.name);
const runningStepRecord = steps.findLast((step) => /\bRunning\b/i.test(step.success)) ?? null;
const failedStepRecord = steps.findLast((step) => /\bNo\b/i.test(step.success)) ?? null;
const runningStep = runningStepRecord?.name ?? null;
const retry = retrySummary(runningStepRecord ?? failedStepRecord);
const completedPageMatch = lastSuccessfulStep.match(/^sync-corpus-page-(\d+)-\d+$/);
const completedPage = completedPageMatch ? Number(completedPageMatch[1]) : null;

assert.equal(workflowName, WORKFLOW_NAME, 'Workflow name');
assert.equal(instanceId, INSTANCE_ID, 'Workflow instance id');
assert.ok(
	NON_FAILURE_STATUSES.has(status),
	`Workflow entered ${status}: ${JSON.stringify({
		lastSuccessfulStep,
		completedPage,
		failedSteps,
		retry,
	})}`,
);
assert.deepEqual(failedSteps, [], 'Workflow failed steps');
if (!ALLOW_IN_PROGRESS) assert.equal(status, 'complete', 'Workflow terminal completion');
const resumeEvidence =
	!ALLOW_IN_PROGRESS && instanceId === RESUME_INSTANCE_ID ? assertResumeCompletion(steps, versionId, lastSuccessfulStep) : null;
const durableState = resumeEvidence ? await assertResumeDurableState(resumeEvidence) : null;

console.info({
	event: ALLOW_IN_PROGRESS ? 'search_rebuild_progress_validated' : 'search_rebuild_completion_validated',
	workflowName,
	instanceId,
	versionId,
	status,
	lastSuccessfulStep,
	completedPage,
	runningStep,
	failedSteps,
	retry,
	resumeEvidence,
	durableState,
});
