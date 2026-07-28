import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKFLOW_NAME = 'newsence-search-index-rebuild';
const INSTANCE_ID = 'search-index-rebuild-canonical-3-kind';
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

function failedStepNames(output) {
	const failed = [];
	for (const block of output.split(/\n(?=\s+Name:\s+)/)) {
		const name = block.match(/^\s+Name:\s+(.+)$/m)?.[1]?.trim();
		const success = block.match(/^\s+Success:\s+(.+)$/m)?.[1]?.trim();
		if (name && success && /\bNo\b/i.test(success)) failed.push(name);
	}
	return failed;
}

function runningStepName(output) {
	for (const block of output.split(/\n(?=\s+Name:\s+)/).reverse()) {
		const name = block.match(/^\s+Name:\s+(.+)$/m)?.[1]?.trim();
		const success = block.match(/^\s+Success:\s+(.+)$/m)?.[1]?.trim();
		if (name && success && /\bRunning\b/i.test(success)) return name;
	}
	return null;
}

const output = describeWorkflowInstance();
const workflowName = header(output, 'Workflow Name');
const instanceId = header(output, 'Instance Id');
const versionId = header(output, 'Version Id');
const status = normalizedStatus(header(output, 'Status'));
const lastSuccessfulStep = header(output, 'Last Successful Step');
const failedSteps = failedStepNames(output);
const runningStep = runningStepName(output);
const completedPageMatch = lastSuccessfulStep.match(/^sync-corpus-page-(\d+)-\d+$/);
const completedPage = completedPageMatch ? Number(completedPageMatch[1]) : null;

assert.equal(workflowName, WORKFLOW_NAME, 'Workflow name');
assert.equal(instanceId, INSTANCE_ID, 'Workflow instance id');
assert.ok(NON_FAILURE_STATUSES.has(status), `Workflow entered ${status}`);
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
});
