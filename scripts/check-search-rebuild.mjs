import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKFLOW_NAME = 'newsence-search-index-rebuild';
const DEFAULT_INSTANCE_ID = 'search-index-rebuild-canonical-3-kind';
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
	const match = value.match(/\b(queued|running|waiting|paused|errored|terminated|complete|unknown)\b/i);
	assert.ok(match, `Workflow status: ${value}`);
	return match[1].toLowerCase();
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
});
