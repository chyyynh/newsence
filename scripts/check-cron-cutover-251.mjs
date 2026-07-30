import assert from 'node:assert/strict';

const WORKER_NAME = 'newsence-core';
const CONTROL_PLANE_STABILIZATION_MS = 2_000;
const PROPAGATION_MS = 15 * 60 * 1_000;
const ACTIVE_SCHEDULES = ['*/5 * * * *', '0 */6 * * *'].sort();
const MODES = ['--pause', '--expect-paused', '--expect-active'];
const EXPECTED_DEPLOYMENT_PREFIX = '--expected-deployment-id=';
const EXPECTED_VERSION_PREFIX = '--expected-version-id=';

const argumentsList = process.argv.slice(2);
const selectedModes = MODES.filter((mode) => argumentsList.includes(mode));
assert.equal(selectedModes.length, 1, `Select exactly one mode: ${MODES.join(', ')}`);
const expectedDeploymentArguments = argumentsList.filter((argument) => argument.startsWith(EXPECTED_DEPLOYMENT_PREFIX));
const expectedVersionArguments = argumentsList.filter((argument) => argument.startsWith(EXPECTED_VERSION_PREFIX));
assert.ok(expectedDeploymentArguments.length <= 1, 'expected deployment ID argument is unique');
assert.ok(expectedVersionArguments.length <= 1, 'expected version ID argument is unique');
const expectedDeploymentId = expectedDeploymentArguments[0]?.slice(EXPECTED_DEPLOYMENT_PREFIX.length) ?? null;
const expectedVersionId = expectedVersionArguments[0]?.slice(EXPECTED_VERSION_PREFIX.length) ?? null;
assert.deepEqual(
	argumentsList.filter(
		(argument) =>
			!MODES.includes(argument) && !argument.startsWith(EXPECTED_DEPLOYMENT_PREFIX) && !argument.startsWith(EXPECTED_VERSION_PREFIX),
	),
	[],
	'unknown operator arguments',
);
const mode = selectedModes[0];
if (mode === '--pause' || mode === '--expect-paused') {
	assert.match(expectedDeploymentId ?? '', /^[0-9a-f-]{36}$/, 'Pin the compatibility deployment ID');
	assert.match(expectedVersionId ?? '', /^[0-9a-f-]{36}$/, 'Pin the compatibility version ID');
} else {
	assert.equal(expectedDeploymentId, null, 'deployment pin is only valid with --pause or --expect-paused');
	assert.equal(expectedVersionId, null, 'version pin is only valid with --pause or --expect-paused');
}

function credentials() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const apiToken = process.env.CLOUDFLARE_WORKFLOWS_API_TOKEN?.trim();
	assert.match(accountId ?? '', /^[0-9a-f]{32}$/, 'Set CLOUDFLARE_ACCOUNT_ID');
	assert.ok(apiToken, 'Set CLOUDFLARE_WORKFLOWS_API_TOKEN with Workers Scripts Read/Write');
	return { accountId, apiToken };
}

function schedulesUrl(accountId) {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKER_NAME}/schedules`;
}

function deploymentsUrl(accountId) {
	return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKER_NAME}/deployments`;
}

async function cloudflareApi(url, apiToken, label, init) {
	const response = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${apiToken}`,
			...(init?.body ? { 'Content-Type': 'application/json' } : {}),
		},
	});
	const payload = await response.json();
	assert.equal(response.ok, true, `${label} HTTP ${response.status}: ${JSON.stringify(payload.errors ?? [])}`);
	assert.equal(payload.success, true, `${label} API`);
	return payload.result;
}

function normalizedSchedules(result, label) {
	assert.ok(Array.isArray(result?.schedules), `${label} schedules`);
	const schedules = result.schedules.map((schedule) => {
		assert.equal(typeof schedule?.cron, 'string', `${label} cron`);
		return schedule.cron;
	});
	assert.equal(new Set(schedules).size, schedules.length, `${label} unique schedules`);
	return schedules.sort();
}

async function loadSchedules(accountId, apiToken, label) {
	const result = await cloudflareApi(schedulesUrl(accountId), apiToken, label);
	return normalizedSchedules(result, label);
}

async function loadDeployment(accountId, apiToken, label) {
	const result = await cloudflareApi(deploymentsUrl(accountId), apiToken, label);
	assert.ok(Array.isArray(result?.deployments) && result.deployments.length > 0, `${label} deployments`);
	const deployment = result.deployments[0];
	assert.match(deployment?.id ?? '', /^[0-9a-f-]{36}$/, `${label} deployment id`);
	assert.equal(deployment?.versions?.length, 1, `${label} active version count`);
	const version = deployment.versions[0];
	assert.match(version?.version_id ?? '', /^[0-9a-f-]{36}$/, `${label} version id`);
	assert.equal(version?.percentage, 100, `${label} active version percentage`);
	return {
		deploymentId: deployment.id,
		versionId: version.version_id,
		percentage: version.percentage,
	};
}

function sameSchedules(actual, expected) {
	return actual.length === expected.length && actual.every((schedule, index) => schedule === expected[index]);
}

function assertSchedules(actual, expected, label) {
	assert.deepEqual(actual, expected, `${label} exact schedules`);
}

function sleep(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const { accountId, apiToken } = credentials();
const deploymentBefore = await loadDeployment(accountId, apiToken, 'deployment before cron operation');
if (mode === '--pause' || mode === '--expect-paused') {
	assert.equal(deploymentBefore.deploymentId, expectedDeploymentId, 'compatibility deployment is pinned before cron operation');
	assert.equal(deploymentBefore.versionId, expectedVersionId, 'compatibility version is pinned before cron operation');
}
const schedulesBefore = await loadSchedules(accountId, apiToken, 'schedules before cron operation');
let pauseRequestedAt = null;
let pauseAppliedAt = null;
let changed = false;

if (mode === '--pause') {
	assert.equal(
		sameSchedules(schedulesBefore, ACTIVE_SCHEDULES) || schedulesBefore.length === 0,
		true,
		'pause requires the exact checked-in schedules or an already-paused worker',
	);
	pauseRequestedAt = new Date().toISOString();
	if (schedulesBefore.length > 0) {
		await cloudflareApi(schedulesUrl(accountId), apiToken, 'pause schedules', {
			body: JSON.stringify([]),
			method: 'PUT',
		});
		changed = true;
	}
	pauseAppliedAt = new Date().toISOString();
}

const expectedSchedules = mode === '--expect-active' ? ACTIVE_SCHEDULES : [];
const schedulesAfterFirstRead = await loadSchedules(accountId, apiToken, 'schedules after cron operation');
assertSchedules(schedulesAfterFirstRead, expectedSchedules, 'first stabilized read');
await sleep(CONTROL_PLANE_STABILIZATION_MS);
const schedulesAfterSecondRead = await loadSchedules(accountId, apiToken, 'schedules after cron stabilization');
assertSchedules(schedulesAfterSecondRead, expectedSchedules, 'second stabilized read');
const deploymentAfter = await loadDeployment(accountId, apiToken, 'deployment after cron operation');
assert.deepEqual(deploymentAfter, deploymentBefore, 'cron control-plane operation must not change the Worker deployment');
if (mode === '--pause' || mode === '--expect-paused') {
	assert.equal(deploymentAfter.deploymentId, expectedDeploymentId, 'compatibility deployment remained pinned during cron propagation');
	assert.equal(deploymentAfter.versionId, expectedVersionId, 'compatibility version remained pinned during cron propagation');
}

const pausePropagationNotBefore = pauseAppliedAt === null ? null : new Date(Date.parse(pauseAppliedAt) + PROPAGATION_MS).toISOString();

process.stdout.write(
	`${JSON.stringify(
		{
			event: 'resource_type_251_cron_cutover_validated',
			mode,
			changed,
			observedAt: new Date().toISOString(),
			pauseRequestedAt,
			pauseAppliedAt,
			pausePropagationNotBefore,
			controlPlaneStabilizationMs: CONTROL_PLANE_STABILIZATION_MS,
			propagationMs: PROPAGATION_MS,
			schedulesBefore,
			schedulesAfter: schedulesAfterSecondRead,
			deployment: deploymentAfter,
		},
		null,
		2,
	)}\n`,
);
