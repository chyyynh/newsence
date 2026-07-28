import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKFLOW_NAME = 'newsence-resource-processing';
const EXPECTED_VERSION_ID = '1d8925fc-7e09-40a0-9fe8-2292779ae811';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const RAW_INSTANCE_ID = process.env.RESOURCE_PROCESSING_CANARY_INSTANCE_ID;
const RAW_CANARY_CASE = process.env.CANARY_CASE;

const CANARIES = {
	'saved-web': {
		instanceId: 'issue245-canary-saved-web-af47bb70-v1',
		kind: 'document',
		legacyType: 'web',
		resourceId: 'af47bb70-b4ba-47a6-a108-60028ad794db',
		resourcePlatform: null,
	},
	'twitter-unchanged': {
		instanceId: 'issue245-canary-twitter-unchanged-081e19f3-v2',
		kind: 'post',
		legacyType: 'twitter',
		resourceId: '081e19f3-59af-4577-bf3f-5fdfadf5ed64',
		resourcePlatform: 'twitter',
	},
	'youtube-description': {
		instanceId: 'issue245-canary-youtube-description-0fbbd6c4-v1',
		kind: 'video',
		legacyType: 'youtube',
		resourceId: '0fbbd6c4-bbb4-467a-9242-74172502c3d9',
		resourcePlatform: 'youtube',
		videoId: 'OcTMwjqje5Q',
	},
};

assert.ok(RAW_INSTANCE_ID, 'Set RESOURCE_PROCESSING_CANARY_INSTANCE_ID to the exact canary Workflow instance');
assert.equal(RAW_INSTANCE_ID, RAW_INSTANCE_ID.trim(), 'RESOURCE_PROCESSING_CANARY_INSTANCE_ID must not contain surrounding whitespace');
assert.notEqual(RAW_INSTANCE_ID, 'latest', 'Resource processing canary verification requires an exact Workflow instance');
assert.ok(RAW_CANARY_CASE, 'Set CANARY_CASE to saved-web, youtube-description, or twitter-unchanged');
assert.equal(RAW_CANARY_CASE, RAW_CANARY_CASE.trim(), 'CANARY_CASE must not contain surrounding whitespace');
assert.ok(Object.hasOwn(CANARIES, RAW_CANARY_CASE), `Unsupported CANARY_CASE: ${RAW_CANARY_CASE}`);

const CANARY_CASE = RAW_CANARY_CASE;
const INSTANCE_ID = RAW_INSTANCE_ID;
const CANARY = CANARIES[CANARY_CASE];

assert.equal(INSTANCE_ID, CANARY.instanceId, `${CANARY_CASE} exact Workflow instance id`);

function describeWorkflowInstance() {
	const result = spawnSync(
		'pnpm',
		['exec', 'wrangler', 'workflows', 'instances', 'describe', WORKFLOW_NAME, INSTANCE_ID, '--truncate-output-limit', '200000'],
		{
			cwd: PACKAGE_ROOT,
			encoding: 'utf8',
			env: {
				...process.env,
				WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-resource-processing-canary-check.log',
			},
			maxBuffer: 64 * 1024 * 1024,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Workflow describe failed (${result.status}): ${result.stderr.trim().slice(-2000)}`);
	}
	return result.stdout.replaceAll(ANSI_ESCAPE, '').replaceAll('\r', '');
}

function header(output, label) {
	const match = output.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
	assert.ok(match, `Workflow describe ${label}`);
	return match[1].trim();
}

function optionalHeader(output, label) {
	return output.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
}

function normalizedStatus(value) {
	const match = value.match(/\b(queued|running|waiting|paused|errored|terminated|completed?|unknown)\b/i);
	assert.ok(match, `Workflow status: ${value}`);
	const status = match[1].toLowerCase();
	return status === 'completed' ? 'complete' : status;
}

function logicalStepName(name) {
	const match = name.match(/^(.+)-(\d+)$/);
	assert.ok(match, `Workflow step has a durable numeric suffix: ${name}`);
	return match[1];
}

function workflowSteps(output) {
	const steps = [];
	for (const block of output.split(/\n(?=\s+Name:\s+)/)) {
		const name = block.match(/^\s+Name:\s+(.+)$/m)?.[1]?.trim();
		const type = block.match(/^\s+Type:\s+(.+)$/m)?.[1]?.trim();
		const success = block.match(/^\s+Success:\s+(.+)$/m)?.[1]?.trim();
		if (!name) continue;
		assert.ok(type, `${name} step type`);
		assert.ok(success, `${name} step success`);
		steps.push({
			logicalName: logicalStepName(name),
			name,
			output: block.match(/^\s+Output:\s+(.+)$/m)?.[1]?.trim() ?? null,
			success,
			type,
		});
	}
	return steps;
}

function exactStep(steps, logicalName, label = logicalName) {
	const matches = steps.filter((step) => step.logicalName === logicalName);
	assert.equal(matches.length, 1, `${label} step count`);
	return matches[0];
}

function hasStep(steps, logicalName) {
	return steps.some((step) => step.logicalName === logicalName);
}

function parseDurableOutput(raw, label) {
	assert.ok(raw, `${label} output`);
	let value;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${label} output is not complete JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (let depth = 0; depth < 2 && typeof value === 'string'; depth += 1) {
		try {
			value = JSON.parse(value);
		} catch {
			break;
		}
	}
	return value;
}

function parsedStepOutput(step, label = step.logicalName) {
	return parseDurableOutput(step.output, label);
}

function parsedObjectPrefix(step, marker, label = step.logicalName) {
	assert.ok(step.output, `${label} output`);
	const decoded = JSON.parse(step.output);
	assert.equal(typeof decoded, 'string', `${label} encoded output`);
	const markerIndex = decoded.indexOf(marker);
	assert.ok(markerIndex > 0, `${label} marker`);
	return JSON.parse(`${decoded.slice(0, markerIndex)}}`);
}

function assertRecord(value, label) {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} object`);
	return value;
}

function assertStepSequence(steps, expected, label) {
	assert.deepEqual(
		steps.map((step) => step.logicalName),
		expected,
		`${label} canonical durable step sequence`,
	);
}

function assertShell(steps) {
	const shell = assertRecord(
		parsedObjectPrefix(exactStep(steps, 'fetch-resource-shell-kind-platform-v1'), ',"title":', `${CANARY_CASE} resource shell`),
		`${CANARY_CASE} resource shell`,
	);
	assert.equal(shell.id, CANARY.resourceId, `${CANARY_CASE} shell resource id`);
	assert.equal(shell.kind, CANARY.kind, `${CANARY_CASE} shell kind`);
	assert.equal(shell.resource_platform ?? null, CANARY.resourcePlatform, `${CANARY_CASE} shell resource platform`);
	return shell;
}

function assertSyncUploaded(steps, logicalName = 'sync-ai-search') {
	const result = parsedStepOutput(exactStep(steps, logicalName), `${CANARY_CASE} AI Search sync`);
	assert.equal(result, 'uploaded', `${CANARY_CASE} AI Search sync result`);
}

function assertChangedPersistence(steps) {
	const persistence = assertRecord(
		parsedStepOutput(exactStep(steps, 'update-db-kind-platform-v1'), `${CANARY_CASE} processed persistence`),
		`${CANARY_CASE} processed persistence`,
	);
	assert.equal(persistence.persisted, true, `${CANARY_CASE} processed persistence current`);
	assert.equal(persistence.resourceId, CANARY.resourceId, `${CANARY_CASE} persisted resource id`);
	return persistence;
}

function changedReturnContract(workflowSuccess, persistedResourceId) {
	const returnContract = {
		changed: true,
		operation: 'resync',
		resource_id: persistedResourceId,
		success: workflowSuccess,
	};
	assert.deepEqual(returnContract, {
		changed: true,
		operation: 'resync',
		resource_id: CANARY.resourceId,
		success: true,
	});
	return returnContract;
}

function assertSavedWebCanary(steps, workflowSuccess) {
	const unchanged = hasStep(steps, 'record-unchanged-resync-index-relevance-v2');
	const changed = hasStep(steps, 'update-db-kind-platform-v1');
	assert.equal(Number(unchanged) + Number(changed), 1, 'saved-web must take exactly one canonical resync branch');

	if (!unchanged) {
		const translationEligible = parsedStepOutput(
			exactStep(steps, 'check-resource-translation-eligibility'),
			'saved-web translation eligibility',
		);
		assert.equal(translationEligible, true, 'saved-web changed branch remains translation eligible');
		const expected = [
			'fetch-resource-shell-kind-platform-v1',
			'acquire-content-kind-platform-v1',
			'validate-resource-content',
			'classify-resource',
			'update-db-kind-platform-v1',
			'rehost-resource-images',
			'check-resource-translation-eligibility',
			'enqueue-resource-translation',
			'sync-ai-search',
		];
		assertStepSequence(steps, expected, 'saved-web changed branch');
		const persistence = assertChangedPersistence(steps);
		assertSyncUploaded(steps);
		return {
			branch: 'changed',
			persistence,
			returnContract: changedReturnContract(workflowSuccess, persistence.resourceId),
			translationEligible,
		};
	}

	const persistence = assertRecord(
		parsedStepOutput(exactStep(steps, 'record-unchanged-resync-index-relevance-v2'), 'saved-web unchanged persistence'),
		'saved-web unchanged persistence',
	);
	assert.equal(persistence.persisted, true, 'saved-web unchanged persistence current');
	assert.equal(typeof persistence.changed, 'boolean', 'saved-web unchanged metadata changed result');
	assert.equal(typeof persistence.indexRelevantChanged, 'boolean', 'saved-web unchanged index relevance result');
	const expected = [
		'fetch-resource-shell-kind-platform-v1',
		'acquire-content-kind-platform-v1',
		'record-unchanged-resync-index-relevance-v2',
		'rehost-resource-images',
		...(persistence.indexRelevantChanged ? ['sync-ai-search-unchanged-resync-index-relevance-v1'] : []),
	];
	assertStepSequence(steps, expected, 'saved-web unchanged branch');
	if (persistence.indexRelevantChanged) assertSyncUploaded(steps, 'sync-ai-search-unchanged-resync-index-relevance-v1');
	const returnContract = {
		changed: false,
		index_relevant_changed: persistence.indexRelevantChanged,
		metadata_changed: persistence.changed,
		operation: 'resync',
		resource_id: CANARY.resourceId,
		success: workflowSuccess,
	};
	assert.equal(returnContract.success, true, 'saved-web unchanged terminal success');
	return {
		branch: 'unchanged',
		persistence,
		returnContract,
		translationEligible: null,
	};
}

function assertTwitterUnchangedCanary(steps, workflowSuccess) {
	const persistence = assertRecord(
		parsedStepOutput(exactStep(steps, 'record-unchanged-resync-index-relevance-v2'), 'twitter-unchanged persistence'),
		'twitter-unchanged persistence',
	);
	assert.equal(persistence.persisted, true, 'twitter-unchanged persistence current');
	assert.equal(persistence.changed, true, 'twitter-unchanged metadata refresh');
	assert.equal(persistence.indexRelevantChanged, false, 'twitter-unchanged index relevance');

	for (const forbidden of [
		'classify-resource',
		'update-db-kind-platform-v1',
		'check-resource-translation-eligibility',
		'enqueue-resource-translation',
		'sync-ai-search',
		'sync-ai-search-unchanged-resync-index-relevance-v1',
	]) {
		assert.equal(hasStep(steps, forbidden), false, `twitter-unchanged forbids ${forbidden}`);
	}

	const hasUnfurl = hasStep(steps, 'unfurl-tweet-external-link');
	assertStepSequence(
		steps,
		[
			'fetch-resource-shell-kind-platform-v1',
			'acquire-content-kind-platform-v1',
			...(hasUnfurl ? ['unfurl-tweet-external-link'] : []),
			'record-unchanged-resync-index-relevance-v2',
			'rehost-resource-images',
		],
		'twitter-unchanged branch',
	);
	const acquired = assertRecord(
		parsedObjectPrefix(exactStep(steps, 'acquire-content-kind-platform-v1'), ',"title":', 'twitter-unchanged acquisition'),
		'twitter-unchanged acquisition',
	);
	assert.equal(acquired.type, 'twitter', 'twitter-unchanged acquired legacy type');
	assert.equal(acquired.resourcePlatform, 'twitter', 'twitter-unchanged acquired resource platform');

	const returnContract = {
		changed: false,
		index_relevant_changed: false,
		metadata_changed: persistence.changed,
		operation: 'resync',
		resource_id: CANARY.resourceId,
		success: workflowSuccess,
	};
	assert.deepEqual(returnContract, {
		changed: false,
		index_relevant_changed: false,
		metadata_changed: persistence.changed,
		operation: 'resync',
		resource_id: CANARY.resourceId,
		success: true,
	});
	return { branch: 'unchanged', persistence, returnContract, translationEligible: null };
}

function assertYoutubeDescriptionCanary(steps, workflowSuccess) {
	assert.equal(hasStep(steps, 'record-unchanged-resync-index-relevance-v2'), false, 'youtube-description must take changed branch');
	assert.equal(hasStep(steps, 'enqueue-resource-translation'), false, 'youtube-description must not enqueue translation');
	assertStepSequence(
		steps,
		[
			'fetch-resource-shell-kind-platform-v1',
			'acquire-content-kind-platform-v1',
			'validate-resource-content',
			'classify-resource',
			'prepare-youtube-highlights',
			'update-db-kind-platform-v1',
			'rehost-resource-images',
			'check-resource-translation-eligibility',
			'sync-ai-search',
		],
		'youtube-description changed branch',
	);

	const acquired = assertRecord(
		parsedObjectPrefix(exactStep(steps, 'acquire-content-kind-platform-v1'), ',"title":', 'youtube-description acquisition'),
		'youtube-description acquisition',
	);
	assert.equal(acquired.type, 'youtube', 'youtube-description acquired legacy type');
	assert.equal(acquired.resourcePlatform, 'youtube', 'youtube-description acquired resource platform');
	assert.equal(
		parsedStepOutput(exactStep(steps, 'prepare-youtube-highlights'), 'youtube-description highlight preparation'),
		null,
		'youtube-description produces no transcript highlights',
	);

	const persistence = assertChangedPersistence(steps);
	const translationEligible = parsedStepOutput(
		exactStep(steps, 'check-resource-translation-eligibility'),
		'youtube-description translation eligibility',
	);
	assert.equal(translationEligible, false, 'youtube-description translation remains ineligible');
	assertSyncUploaded(steps);
	return {
		branch: 'changed',
		persistence,
		returnContract: changedReturnContract(workflowSuccess, persistence.resourceId),
		translationEligible,
	};
}

const output = describeWorkflowInstance();
const workflowName = header(output, 'Workflow Name');
const describedInstanceId = header(output, 'Instance Id');
const versionId = header(output, 'Version Id');
const status = normalizedStatus(header(output, 'Status'));
const workflowSuccess = /\bYes\b/i.test(header(output, 'Success'));
const workflowError = optionalHeader(output, 'Error');
const lastSuccessfulStep = header(output, 'Last Successful Step');
const steps = workflowSteps(output);
const failedSteps = steps.filter((step) => !/\bYes\b/i.test(step.success)).map((step) => step.name);

assert.equal(workflowName, WORKFLOW_NAME, 'Workflow name');
assert.equal(describedInstanceId, INSTANCE_ID, 'Workflow instance id');
assert.equal(versionId, EXPECTED_VERSION_ID, 'Workflow version');
assert.equal(status, 'complete', 'Workflow terminal status');
assert.equal(workflowSuccess, true, 'Workflow terminal success');
assert.equal(workflowError, null, 'Workflow terminal error');
assert.ok(steps.length > 0, 'Workflow durable steps');
assert.deepEqual(failedSteps, [], 'Workflow failed steps');
assert.equal(lastSuccessfulStep, steps.at(-1)?.name, 'Workflow final successful step');
for (const step of steps) assert.match(step.type, /\bStep\b/i, `${step.name} durable step type`);

const shell = assertShell(steps);
let evidence;
switch (CANARY_CASE) {
	case 'saved-web':
		evidence = assertSavedWebCanary(steps, workflowSuccess);
		break;
	case 'twitter-unchanged':
		evidence = assertTwitterUnchangedCanary(steps, workflowSuccess);
		break;
	case 'youtube-description':
		evidence = assertYoutubeDescriptionCanary(steps, workflowSuccess);
		break;
	default:
		throw new Error(`Unsupported canary case: ${CANARY_CASE}`);
}

console.info({
	event: 'resource_processing_canary_validated',
	canaryCase: CANARY_CASE,
	workflowName,
	instanceId: describedInstanceId,
	versionId,
	status,
	lastSuccessfulStep,
	resourceIdentity: {
		kind: shell.kind,
		resourceId: shell.id,
		resourcePlatform: shell.resource_platform ?? null,
	},
	legacyTypeVerification: {
		expected: CANARY.legacyType,
		observedInAcquisition: CANARY_CASE !== 'saved-web',
		authoritativeGate: 'check:resource-runtime-canary-state',
	},
	...evidence,
	workflowReturnObserved: false,
	tailEvidenceRequired:
		CANARY_CASE === 'youtube-description'
			? `Confirm the exact Core tail for ${CANARY.videoId} contains "Transcript unavailable; using video description"; the post-canary DB verifier must prove a non-empty description and one zero-segment transcript row. Workflow describe cannot prove either from its truncated output.`
			: null,
});
