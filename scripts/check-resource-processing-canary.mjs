import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKFLOW_NAME = 'newsence-resource-processing';
const EXPECTED_VERSION_ID = 'eadd2de4-9c68-4b02-9066-c62185172222';
const EXPECTED_CORE_VERSION_ID = '093ac86e-0408-41a4-a660-be1f20bbceda';
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const RAW_INSTANCE_ID = process.env.RESOURCE_PROCESSING_CANARY_INSTANCE_ID;
const RAW_CANARY_CASE = process.env.CANARY_CASE;
const RAW_TAIL_FILE = process.env.RESOURCE_PROCESSING_CANARY_TAIL_FILE;

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
		instanceId: 'issue245-canary-youtube-description-e413960f-v1',
		kind: 'video',
		legacyType: 'youtube',
		resourceId: 'e413960f-1d87-4b9d-9c33-2ae67ea19dac',
		resourcePlatform: 'youtube',
		videoId: '657wlbtrzG8',
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

let cachedWranglerApiCredentials = null;

function wranglerApiCredentials() {
	if (cachedWranglerApiCredentials) return cachedWranglerApiCredentials;
	const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const envApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (envAccountId && envApiToken) {
		assert.match(envAccountId, /^[0-9a-f]{32}$/, 'Cloudflare account id');
		cachedWranglerApiCredentials = { accountId: envAccountId, apiToken: envApiToken };
		return cachedWranglerApiCredentials;
	}
	const whoami = spawnSync('pnpm', ['exec', 'wrangler', 'whoami'], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/newsence-resource-processing-canary-check.log',
		},
		maxBuffer: 4 * 1024 * 1024,
	});
	if (whoami.error) throw whoami.error;
	if (whoami.status !== 0) throw new Error(`Wrangler whoami failed (${whoami.status})`);
	const output = whoami.stdout.replaceAll(ANSI_ESCAPE, '');
	const accountId = envAccountId || output.match(/\b[0-9a-f]{32}\b/)?.[0];
	assert.match(accountId ?? '', /^[0-9a-f]{32}$/, 'Cloudflare account id');
	if (envApiToken) {
		cachedWranglerApiCredentials = { accountId, apiToken: envApiToken };
		return cachedWranglerApiCredentials;
	}
	const credentialsPath = output.match(/Credentials are stored in:\s*(.+)$/m)?.[1]?.trim();
	assert.ok(credentialsPath, 'Wrangler OAuth credentials path');
	const credentials = readFileSync(credentialsPath, 'utf8');
	const encodedToken = credentials.match(/^oauth_token\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m)?.[1];
	assert.ok(encodedToken, 'Wrangler OAuth token');
	cachedWranglerApiCredentials = { accountId, apiToken: JSON.parse(encodedToken) };
	return cachedWranglerApiCredentials;
}

function retryDelay(response, attempt) {
	const seconds = Number(response.headers.get('retry-after'));
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 20_000) : Math.min(500 * 2 ** attempt, 5000);
}

async function workflowApi(pathname = '', searchParams = {}, attempt = 0) {
	const { accountId, apiToken } = wranglerApiCredentials();
	const endpoint = new URL(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/${WORKFLOW_NAME}/instances/${INSTANCE_ID}${pathname}`,
	);
	for (const [key, value] of Object.entries(searchParams)) endpoint.searchParams.set(key, value);
	const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiToken}` } });
	if (response.status === 429 && attempt < 6) {
		const delay = retryDelay(response, attempt);
		await response.text();
		await new Promise((resolve) => setTimeout(resolve, delay));
		return workflowApi(pathname, searchParams, attempt + 1);
	}
	const contentType = response.headers.get('content-type') ?? '';
	if (response.ok && contentType.includes('application/octet-stream')) {
		assert.equal(pathname, '/step', 'Workflow stream response is a step output');
		const rawOutput = await response.text();
		assert.ok(rawOutput.length > 0, 'Workflow stream step output');
		let output = rawOutput;
		try {
			output = JSON.parse(rawOutput);
		} catch {
			// A Workflow step may intentionally return arbitrary stream bytes.
		}
		return { output, responseMode: 'octet-stream', statusObserved: false };
	}
	const payload = await response.json();
	assert.equal(response.ok, true, `Workflow API HTTP ${response.status}`);
	assert.equal(payload.success, true, 'Workflow API success');
	return { ...payload.result, responseMode: 'json', statusObserved: true };
}

function expectedApiStepSequence(stepCount) {
	const commonStart = ['fetch-resource-shell-kind-platform-v1', 'acquire-content-kind-platform-v1'];
	switch (CANARY_CASE) {
		case 'saved-web':
			if (stepCount === 9) {
				return [
					...commonStart,
					'validate-resource-content',
					'classify-resource',
					'update-db-kind-platform-v1',
					'rehost-resource-images',
					'check-resource-translation-eligibility',
					'enqueue-resource-translation',
					'sync-ai-search',
				];
			}
			if (stepCount === 4 || stepCount === 5) {
				return [
					...commonStart,
					'record-unchanged-resync-index-relevance-v2',
					'rehost-resource-images',
					...(stepCount === 5 ? ['sync-ai-search-unchanged-resync-index-relevance-v1'] : []),
				];
			}
			break;
		case 'twitter-unchanged':
			if (stepCount === 4 || stepCount === 5) {
				return [
					...commonStart,
					...(stepCount === 5 ? ['unfurl-tweet-external-link'] : []),
					'record-unchanged-resync-index-relevance-v2',
					'rehost-resource-images',
				];
			}
			break;
		case 'youtube-description':
			if (stepCount === 9) {
				return [
					...commonStart,
					'validate-resource-content',
					'classify-resource',
					'prepare-youtube-highlights',
					'update-db-kind-platform-v1',
					'rehost-resource-images',
					'check-resource-translation-eligibility',
					'sync-ai-search',
				];
			}
			break;
		default:
			break;
	}
	assert.fail(`${CANARY_CASE} unexpected Workflow step count: ${stepCount}`);
}

async function workflowInstanceEvidence() {
	const metadata = await workflowApi('', { simple: 'true' });
	const stepCount = metadata?.step_count;
	assert.ok(Number.isInteger(stepCount), 'Workflow API step count');
	assert.ok(Array.isArray(metadata.steps), 'Workflow API simple steps');
	assert.equal(metadata.steps.length, 0, 'Workflow API simple response omits step details');
	const logicalNames = expectedApiStepSequence(stepCount);
	assert.equal(logicalNames.length, stepCount, `${CANARY_CASE} exact Workflow step count`);
	const steps = [];
	for (const logicalName of logicalNames) {
		if (steps.length > 0) await new Promise((resolve) => setTimeout(resolve, 350));
		const name = `${logicalName}-1`;
		const result = await workflowApi('/step', { name, type: 'step' });
		if (result.statusObserved) {
			assert.equal(result?.status, 'complete', `${name} full step status`);
			assert.equal(result.error ?? null, null, `${name} full step error`);
			assert.equal(Object.hasOwn(result, 'output'), true, `${name} full step output field`);
		}
		steps.push({
			logicalName,
			name,
			output: JSON.stringify(result.output),
			responseMode: result.responseMode,
			statusObserved: result.statusObserved,
			type: 'Step',
		});
	}
	assert.equal(new Set(steps.map((step) => step.name)).size, stepCount, `${CANARY_CASE} distinct physical step names`);
	return { metadata, steps };
}

function normalizedStatus(value) {
	const match = value.match(/\b(queued|running|waiting|paused|errored|terminated|completed?|unknown)\b/i);
	assert.ok(match, `Workflow status: ${value}`);
	const status = match[1].toLowerCase();
	return status === 'completed' ? 'complete' : status;
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
	if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) return decoded;
	assert.equal(typeof decoded, 'string', `${label} encoded output`);
	const markerIndex = decoded.indexOf(marker);
	assert.ok(markerIndex > 0, `${label} marker`);
	return JSON.parse(`${decoded.slice(0, markerIndex)}}`);
}

function assertRecord(value, label) {
	assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} object`);
	return value;
}

function assertStepContract(steps, expected, label) {
	assert.deepEqual(steps.map((step) => step.logicalName).toSorted(), expected.toSorted(), `${label} exact durable step set`);
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
		assertStepContract(steps, expected, 'saved-web changed branch');
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
	assertStepContract(steps, expected, 'saved-web unchanged branch');
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
	assertStepContract(
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
	assertStepContract(
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
	assert.equal(acquired.markdown?.length, 304, 'youtube-description acquired Markdown length');
	assert.equal(acquired.metadata?.description?.length, 304, 'youtube-description acquired description length');
	assert.equal(acquired.platformMetadata?.data?.videoId, CANARY.videoId, 'youtube-description acquired platform video id');
	assert.equal(
		acquired.platformMetadata?.sourceSnapshotHash,
		'7cf09dc954db38a54b37dfa9b541385022303ba8efc56f7c2647a037cf79ce9f',
		'youtube-description acquired source snapshot',
	);
	assert.equal(acquired.youtubeTranscript?.videoId, CANARY.videoId, 'youtube-description transcript video id');
	assert.deepEqual(acquired.youtubeTranscript?.segments, [], 'youtube-description acquired zero transcript segments');
	assert.equal(acquired.youtubeTranscript?.language, 'zh', 'youtube-description transcript language');
	assert.equal(acquired.youtubeTranscript?.chapters?.length, 5, 'youtube-description inferred chapters');
	assert.equal(acquired.youtubeTranscript?.chaptersFromDescription, true, 'youtube-description chapters from description');
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

function youtubeTailEvidence() {
	if (CANARY_CASE !== 'youtube-description') return null;
	assert.ok(RAW_TAIL_FILE, 'Set RESOURCE_PROCESSING_CANARY_TAIL_FILE to the exact pinned Core tail JSON');
	const tail = JSON.parse(readFileSync(RAW_TAIL_FILE, 'utf8'));
	assert.equal(tail.scriptVersion?.id, EXPECTED_CORE_VERSION_ID, 'YouTube tail Core version');
	assert.equal(tail.scriptName, 'newsence-core', 'YouTube tail Worker name');
	assert.equal(tail.entrypoint, 'ResourceProcessingWorkflow', 'YouTube tail entrypoint');
	assert.equal(tail.tailAttributes?.workflowName, WORKFLOW_NAME, 'YouTube tail Workflow name');
	assert.equal(tail.tailAttributes?.instanceId, INSTANCE_ID, 'YouTube tail Workflow instance');
	assert.equal(tail.event?.rpcMethod, 'run', 'YouTube tail RPC method');
	assert.deepEqual(tail.exceptions ?? [], [], 'YouTube tail exceptions');
	const messages =
		tail.logs
			?.flatMap((log) => (log.message ?? []).map((message) => ({ level: log.level, message })))
			.filter(({ message }) => message && typeof message === 'object') ?? [];
	const fallback = messages.filter(
		({ level, message }) =>
			level === 'warn' &&
			message.tag === 'YOUTUBE' &&
			message.msg === 'Transcript unavailable; using video description' &&
			message.videoId === CANARY.videoId,
	);
	assert.equal(fallback.length, 1, 'YouTube description fallback tail event');
	const completed = messages.filter(
		({ message }) => message.tag === 'WORKFLOW' && message.msg === 'Completed' && message.resource_id === CANARY.resourceId,
	);
	assert.equal(completed.length, 1, 'YouTube description completed tail event');
	return {
		coreVersionId: tail.scriptVersion.id,
		fallbackMessage: fallback[0].message.msg,
		videoId: fallback[0].message.videoId,
		workflowCompleted: true,
	};
}

const { metadata, steps } = await workflowInstanceEvidence();
const workflowName = WORKFLOW_NAME;
const describedInstanceId = INSTANCE_ID;
const versionId = metadata.versionId;
const status = normalizedStatus(metadata.status);
const workflowSuccess = metadata.success === true;
const workflowError = metadata.error ?? null;
const expectedTerminalStep = steps.at(-1)?.name;

assert.equal(workflowName, WORKFLOW_NAME, 'Workflow name');
assert.equal(describedInstanceId, INSTANCE_ID, 'Workflow instance id');
assert.equal(versionId, EXPECTED_VERSION_ID, 'Workflow version');
assert.equal(status, 'complete', 'Workflow terminal status');
assert.equal(workflowSuccess, true, 'Workflow terminal success');
assert.equal(workflowError, null, 'Workflow terminal error');
assert.ok(steps.length > 0, 'Workflow durable steps');
assert.deepEqual(metadata.params, { resourceId: CANARY.resourceId, operation: 'resync' }, 'Workflow input parameters');
assert.equal(metadata.trigger?.source, 'api', 'Workflow trigger source');
assert.equal(metadata.rollback ?? null, null, 'Workflow rollback');
assert.ok(metadata.end, 'Workflow terminal end timestamp');
for (const timestamp of [metadata.queued, metadata.start, metadata.end]) {
	assert.ok(Number.isFinite(Date.parse(timestamp)), `Workflow timestamp: ${timestamp}`);
}
assert.ok(Date.parse(metadata.queued) <= Date.parse(metadata.start), 'Workflow queued before start');
assert.ok(Date.parse(metadata.start) <= Date.parse(metadata.end), 'Workflow start before end');
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
assert.deepEqual(metadata.output, evidence.returnContract, `${CANARY_CASE} observed Workflow return contract`);
const tailEvidence = youtubeTailEvidence();

console.info({
	event: 'resource_processing_canary_validated',
	canaryCase: CANARY_CASE,
	workflowName,
	instanceId: describedInstanceId,
	versionId,
	status,
	expectedTerminalStep,
	stepOrderObserved: false,
	streamStepCompletionInferredFromTerminalInstance: steps.filter((step) => !step.statusObserved).map((step) => step.name),
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
	workflowReturnObserved: true,
	workflowEvidenceSource: 'Cloudflare simple instance metadata plus full step output API',
	tailEvidence,
});
