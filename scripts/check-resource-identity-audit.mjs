import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKFLOW_NAME = 'newsence-resource-identity-backfill';
const EXPECTED_VERSION_ID = 'c6563784-422f-4b60-9236-68c9b7cf5d3f';
const INSTANCE_ID = process.env.RESOURCE_IDENTITY_AUDIT_INSTANCE_ID?.trim();
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

assert.ok(INSTANCE_ID, 'Set RESOURCE_IDENTITY_AUDIT_INSTANCE_ID to the exact final audit Workflow instance');
assert.notEqual(INSTANCE_ID, 'latest', 'Final resource identity audit must name an exact Workflow instance');

function describeWorkflowInstance() {
	const result = spawnSync(
		'pnpm',
		['exec', 'wrangler', 'workflows', 'instances', 'describe', WORKFLOW_NAME, INSTANCE_ID, '--truncate-output-limit', '200000'],
		{
			cwd: PACKAGE_ROOT,
			encoding: 'utf8',
			env: {
				...process.env,
				WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-resource-identity-audit-check.log',
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
		steps.push({
			name,
			success,
			output: block.match(/^\s+Output:\s+(.+)$/m)?.[1]?.trim() ?? null,
		});
	}
	return steps;
}

function exactStep(steps, pattern, label) {
	const matches = steps.filter((step) => pattern.test(step.name));
	assert.equal(matches.length, 1, `${label} step count`);
	return matches[0];
}

function parsedStepOutput(step, label) {
	assert.ok(step.output, `${label} output`);
	let parsed = JSON.parse(step.output);
	if (typeof parsed === 'string' && /^[{[]/.test(parsed.trim())) parsed = JSON.parse(parsed);
	return parsed;
}

function parsedObjectPrefix(step, marker, label) {
	assert.ok(step.output, `${label} output`);
	const decoded = JSON.parse(step.output);
	assert.equal(typeof decoded, 'string', `${label} encoded output`);
	const markerIndex = decoded.indexOf(marker);
	assert.ok(markerIndex > 0, `${label} marker`);
	return JSON.parse(`${decoded.slice(0, markerIndex)}}`);
}

function assertUtcTimestamp(value, label) {
	assert.equal(typeof value, 'string', `${label} type`);
	assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,6})?Z$/, `${label} format`);
	assert.equal(Number.isNaN(Date.parse(value)), false, `${label} value`);
}

function assertZeroFields(value, fields, label) {
	for (const field of fields) assert.equal(value[field], 0, `${label} ${field}`);
}

function assertCleanAudit(audit, label) {
	assert.ok(Number.isSafeInteger(audit.scanned) && audit.scanned > 0, `${label} scanned rows`);
	assert.equal(audit.matches, audit.scanned, `${label} every row matches`);
	assert.ok(Number.isSafeInteger(audit.pages) && audit.pages > 0, `${label} pages`);
	assertZeroFields(
		audit,
		[
			'missing',
			'plannedWrites',
			'conflicts',
			'unmapped',
			'invalidCurrentIdentities',
			'enrichedDetectorMismatches',
			'blockingRows',
			'overflowBlockingGroups',
			'overflowBlockingRows',
		],
		label,
	);
	assert.deepEqual(audit.overflowBlockingSampleResourceIds, [], `${label} overflow blocking samples`);
}

const output = describeWorkflowInstance();
const workflowName = header(output, 'Workflow Name');
const instanceId = header(output, 'Instance Id');
const versionId = header(output, 'Version Id');
const status = normalizedStatus(header(output, 'Status'));
const lastSuccessfulStep = header(output, 'Last Successful Step');
const steps = workflowSteps(output);
const failedSteps = steps.filter((step) => /\bNo\b/i.test(step.success)).map((step) => step.name);

assert.equal(workflowName, WORKFLOW_NAME, 'Workflow name');
assert.equal(instanceId, INSTANCE_ID, 'Workflow instance id');
assert.equal(versionId, EXPECTED_VERSION_ID, 'Workflow version');
assert.equal(status, 'complete', 'Workflow terminal status');
assert.equal(lastSuccessfulStep, 'record-resource-identity-backfill-summary-1', 'Workflow final summary step');
assert.deepEqual(failedSteps, [], 'Workflow failed steps');

const snapshotAt = parsedStepOutput(
	exactStep(steps, /^resolve-resource-identity-backfill-snapshot-\d+$/, 'resource identity audit snapshot'),
	'resource identity audit snapshot',
);
const preflight = parsedObjectPrefix(
	exactStep(steps, /^record-resource-identity-backfill-preflight-\d+$/, 'resource identity audit preflight'),
	',"sampleGroups":',
	'resource identity audit preflight',
);
const invariants = parsedStepOutput(
	exactStep(steps, /^load-resource-identity-backfill-invariants-\d+$/, 'resource identity audit invariants'),
	'resource identity audit invariants',
);
const summary = parsedObjectPrefix(
	exactStep(steps, /^record-resource-identity-backfill-summary-\d+$/, 'resource identity audit summary'),
	',"before":',
	'resource identity audit summary',
);
assert.equal(summary.mode, 'audit', 'resource identity Workflow mode');
assert.equal(summary.snapshotAt, snapshotAt, 'resource identity audit summary snapshot');
assertUtcTimestamp(snapshotAt, 'resource identity audit snapshot');
assertCleanAudit(preflight, 'resource identity audit preflight');
assert.equal(
	steps.some((step) => /^(?:write|convergence)-resource-identity-page-\d+-\d+$/.test(step.name)),
	false,
	'resource identity audit performs no write phase',
);
assert.equal(invariants.scanned, preflight.scanned, 'resource identity audit invariant row count');
assertZeroFields(
	invariants,
	['missingKind', 'platformWithoutKind', 'invalidKind', 'invalidPlatform', 'invalidKindPlatform'],
	'resource identity audit invariants',
);

console.info({
	event: 'resource_identity_final_audit_validated',
	workflowName,
	instanceId,
	versionId,
	status,
	snapshotAt,
	scanned: preflight.scanned,
	matches: preflight.matches,
	pages: preflight.pages,
	detectorMismatches: preflight.enrichedDetectorMismatches,
	blockingRows: preflight.blockingRows,
	invariants,
});
