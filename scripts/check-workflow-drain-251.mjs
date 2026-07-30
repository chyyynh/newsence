import assert from 'node:assert/strict';

const REQUIRE_FINAL_WORKFLOWS = process.argv.includes('--require-final-workflows');
const ALLOWED_ARGUMENTS = new Set(['--require-final-workflows']);
const STABILIZATION_MS = 2_000;
const PER_PAGE = 100;
const NONTERMINAL_STATUSES = ['queued', 'running', 'paused', 'waiting', 'waitingForPause', 'rollingBack'];
const TERMINAL_AGGREGATE_STATUSES = new Set(['complete', 'errored', 'terminated']);
const EXPECTED_AGGREGATE_STATUSES = [...NONTERMINAL_STATUSES, ...TERMINAL_AGGREGATE_STATUSES];
const PRE_FINAL_WORKFLOWS = [
	'newsence-resource-processing',
	'newsence-resource-translation',
	'newsence-search-index-rebuild',
	'newsence-search-index-shadow-rebuild',
	'newsence-search-index-terminal-repair-251',
	'newsence-search-index-terminal-repair-251-v2',
	'newsence-search-index-stuck-item-recovery-251',
	'newsence-search-index-stuck-item-recovery-251-v2',
	'newsence-search-index-stuck-item-recovery-251-v3',
	'newsence-recent-resource-image-backfill',
	'newsence-academic-metadata-backfill',
	'newsence-resource-identity-backfill',
];
const FINAL_WORKFLOWS = [
	'newsence-resource-processing-v2',
	'newsence-resource-translation-v2',
	'newsence-search-index-canonical-v6-rebuild',
	'newsence-recent-resource-image-backfill-v2',
	'newsence-academic-metadata-backfill-v3',
];
const FINAL_WORKFLOW_SET = new Set(FINAL_WORKFLOWS);
const WORKFLOWS = [...PRE_FINAL_WORKFLOWS, ...FINAL_WORKFLOWS];

assert.deepEqual(
	process.argv.slice(2).filter((argument) => !ALLOWED_ARGUMENTS.has(argument)),
	[],
	'unknown operator arguments',
);
assert.equal(new Set(WORKFLOWS).size, WORKFLOWS.length, 'unique Workflow names');
assert.equal(
	FINAL_WORKFLOWS.every((workflowName) => WORKFLOWS.includes(workflowName)),
	true,
	'final Workflows are included in the drain',
);

function credentials() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const workflowsToken = process.env.CLOUDFLARE_WORKFLOWS_API_TOKEN?.trim();
	assert.match(accountId ?? '', /^[0-9a-f]{32}$/, 'Set CLOUDFLARE_ACCOUNT_ID');
	assert.ok(workflowsToken, 'Set CLOUDFLARE_WORKFLOWS_API_TOKEN');
	return { accountId, workflowsToken };
}

function workflowInstancesUrl(accountId, workflowName, status, cursor) {
	const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/${workflowName}/instances`);
	url.searchParams.set('direction', 'asc');
	url.searchParams.set('per_page', String(PER_PAGE));
	url.searchParams.set('status', status);
	if (cursor) url.searchParams.set('cursor', cursor);
	return url;
}

function workflowUrl(accountId, workflowName) {
	return new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/${workflowName}`);
}

function isMissingWorkflow(response, payload) {
	return response.status === 404 && payload.success === false && payload.errors?.some((error) => error.code === 10_200);
}

async function getWorkflowAggregate(accountId, workflowsToken, workflowName, position) {
	const response = await fetch(workflowUrl(accountId, workflowName), {
		headers: { Authorization: `Bearer ${workflowsToken}` },
	});
	const payload = await response.json();
	if (isMissingWorkflow(response, payload)) return { absent: true, instances: null };
	assert.equal(response.ok, true, `${workflowName}/${position} aggregate HTTP ${response.status}: ${JSON.stringify(payload.errors ?? [])}`);
	assert.equal(payload.success, true, `${workflowName}/${position} aggregate API`);
	assert.equal(payload.result?.name, workflowName, `${workflowName}/${position} aggregate name`);
	const instances = payload.result?.instances;
	assert.ok(instances && typeof instances === 'object' && !Array.isArray(instances), `${workflowName}/${position} aggregate instances`);
	for (const status of EXPECTED_AGGREGATE_STATUSES) {
		assert.equal(Object.hasOwn(instances, status), true, `${workflowName}/${position} aggregate ${status} exists`);
	}
	for (const [status, count] of Object.entries(instances)) {
		assert.ok(Number.isSafeInteger(count) && count >= 0, `${workflowName}/${position} aggregate ${status} count`);
		if (!TERMINAL_AGGREGATE_STATUSES.has(status)) {
			assert.equal(count, 0, `${workflowName}/${position} aggregate ${status} must be drained`);
		}
	}
	return { absent: false, instances };
}

async function listStatus(accountId, workflowsToken, workflowName, status) {
	const instances = [];
	const observedCursors = new Set();
	let cursor;
	let pageCount = 0;
	for (;;) {
		const response = await fetch(workflowInstancesUrl(accountId, workflowName, status, cursor), {
			headers: { Authorization: `Bearer ${workflowsToken}` },
		});
		const payload = await response.json();
		if (isMissingWorkflow(response, payload)) {
			assert.equal(pageCount, 0, `${workflowName} disappeared during pagination`);
			return { absent: true, instances: [], pageCount: 0 };
		}
		assert.equal(response.ok, true, `${workflowName}/${status} HTTP ${response.status}: ${JSON.stringify(payload.errors ?? [])}`);
		assert.equal(payload.success, true, `${workflowName}/${status} API`);
		assert.ok(Array.isArray(payload.result), `${workflowName}/${status} result`);
		pageCount += 1;
		for (const instance of payload.result) {
			assert.equal(instance.status, status, `${workflowName}/${status} instance status`);
			assert.ok(instance.id, `${workflowName}/${status} instance id`);
			instances.push({
				createdOn: instance.created_on ?? null,
				id: instance.id,
				modifiedOn: instance.modified_on ?? null,
				status: instance.status,
				versionId: instance.version_id ?? null,
			});
		}
		const nextCursor = payload.result_info?.cursor?.trim() || null;
		if (!nextCursor) break;
		assert.equal(observedCursors.has(nextCursor), false, `${workflowName}/${status} cursor loop`);
		observedCursors.add(nextCursor);
		cursor = nextCursor;
	}
	assert.equal(new Set(instances.map((instance) => instance.id)).size, instances.length, `${workflowName}/${status} unique instances`);
	return { absent: false, instances, pageCount };
}

async function scanWorkflow(accountId, workflowsToken, workflowName) {
	const aggregateBefore = await getWorkflowAggregate(accountId, workflowsToken, workflowName, 'before');
	const results = await Promise.all(NONTERMINAL_STATUSES.map((status) => listStatus(accountId, workflowsToken, workflowName, status)));
	const aggregateAfter = await getWorkflowAggregate(accountId, workflowsToken, workflowName, 'after');
	const existenceObservations = [aggregateBefore, ...results, aggregateAfter];
	const absentCount = existenceObservations.filter((result) => result.absent).length;
	assert.ok(absentCount === 0 || absentCount === existenceObservations.length, `${workflowName} existence changed during one drain sweep`);
	const absent = absentCount > 0;
	if (absent) {
		assert.equal(FINAL_WORKFLOW_SET.has(workflowName), true, `required pre-final Workflow ${workflowName} is absent`);
	}
	if (REQUIRE_FINAL_WORKFLOWS && FINAL_WORKFLOW_SET.has(workflowName)) {
		assert.equal(absent, false, `required final Workflow ${workflowName} is absent`);
	}
	const activeInstances = results.flatMap((result, index) =>
		result.instances.map((instance) => ({
			...instance,
			workflowName,
			observedStatus: NONTERMINAL_STATUSES[index],
		})),
	);
	return {
		aggregates: absent
			? null
			: {
					after: aggregateAfter.instances,
					before: aggregateBefore.instances,
				},
		activeInstances,
		exists: !absent,
		statuses: absent
			? []
			: results.map((result, index) => ({
					count: result.instances.length,
					pageCount: result.pageCount,
					status: NONTERMINAL_STATUSES[index],
				})),
		workflowName,
	};
}

async function scanAllWorkflows(accountId, workflowsToken) {
	const workflows = [];
	for (const workflowName of WORKFLOWS) {
		workflows.push(await scanWorkflow(accountId, workflowsToken, workflowName));
	}
	return {
		observedAt: new Date().toISOString(),
		workflows,
	};
}

function sleep(durationMs) {
	return new Promise((resolve) => setTimeout(resolve, durationMs));
}

const { accountId, workflowsToken } = credentials();
const firstSweep = await scanAllWorkflows(accountId, workflowsToken);
await sleep(STABILIZATION_MS);
const secondSweep = await scanAllWorkflows(accountId, workflowsToken);
for (const [index, firstWorkflow] of firstSweep.workflows.entries()) {
	const secondWorkflow = secondSweep.workflows[index];
	assert.equal(secondWorkflow.workflowName, firstWorkflow.workflowName, 'stable Workflow scan order');
	assert.equal(secondWorkflow.exists, firstWorkflow.exists, `${firstWorkflow.workflowName} existence changed between drain sweeps`);
}
const activeInstances = [firstSweep, secondSweep].flatMap((sweep) =>
	sweep.workflows.flatMap((workflow) =>
		workflow.activeInstances.map((instance) => ({
			...instance,
			sweepObservedAt: sweep.observedAt,
		})),
	),
);
assert.deepEqual(activeInstances, [], 'all #251 Workflow graphs must be drained');

process.stdout.write(
	`${JSON.stringify(
		{
			event: 'resource_type_251_workflow_drain_validated',
			observedAt: {
				firstSweep: firstSweep.observedAt,
				secondSweep: secondSweep.observedAt,
			},
			requireFinalWorkflows: REQUIRE_FINAL_WORKFLOWS,
			stabilizationMs: STABILIZATION_MS,
			nonterminalStatuses: NONTERMINAL_STATUSES,
			activeCount: activeInstances.length,
			existingWorkflowCount: secondSweep.workflows.filter((workflow) => workflow.exists).length,
			absentWorkflows: secondSweep.workflows.filter((workflow) => !workflow.exists).map((workflow) => workflow.workflowName),
			workflows: secondSweep.workflows.map(({ activeInstances: _activeInstances, ...workflow }) => workflow),
		},
		null,
		2,
	)}\n`,
);
