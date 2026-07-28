import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const WORKFLOW_NAME = 'newsence-search-index-rebuild';
const DEFAULT_INSTANCE_ID = 'search-index-rebuild-canonical-3-kind';
const RESUME_INSTANCE_ID = 'search-index-rebuild-canonical-3-kind-resume-v1';
const READINESS_INSTANCE_ID = 'search-index-rebuild-canonical-3-kind-readiness-v1';
const RESUME_VERSION_ID = '94064547-549b-4d1e-adb0-893c5f232792';
const READINESS_VERSION_ID = 'e0445ff4-222f-4e54-b6a5-1bdd95d2476f';
const RESUME_STARTED_AT = '2026-07-28T05:31:32.516Z';
const READINESS_CHECKPOINT_KEY = 'canonical-3-kind-resume-v1-readiness-timeout';
const READINESS_TIMEOUT_ERROR_PREFIX = 'AI Search index did not become ready:';
const READINESS_INITIAL_REPAIR_DIGEST = '710d51c0b740233a3634ab8e1b22e1d74f9dfc0c5954d303b8fcf2e717ce9c21';
const READINESS_MAX_REPAIR_ROUNDS = 3;
const RESUME_REBUILD_EPOCH = 2;
const READINESS_REBUILD_EPOCH = 3;
const RESUME_FINAL_READINESS_ATTEMPT = 35;
const RESUME_TERMINAL_EXPECTED = {
	total: 32_223,
	byKind: {
		document: 23_079,
		post: 8_673,
		video: 457,
		paper: 14,
	},
};
const RESUME_TERMINAL_OWNED_STATUSES = {
	completed: 30_775,
	error: 1,
	outdated: 27,
	queued: 1_325,
	running: 95,
	skipped: 0,
};
const INSTANCE_ID = process.env.SEARCH_REBUILD_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
const ALLOW_IN_PROGRESS = process.argv.includes('--allow-in-progress');
const EXPECT_READINESS_TIMEOUT = process.argv.includes('--expect-readiness-timeout');
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const NON_FAILURE_STATUSES = new Set(['queued', 'running', 'waiting', 'complete']);

assert.equal(
	ALLOW_IN_PROGRESS && EXPECT_READINESS_TIMEOUT,
	false,
	'--allow-in-progress and --expect-readiness-timeout are mutually exclusive',
);

function describeWorkflowInstance() {
	const result = spawnSync(
		'pnpm',
		['exec', 'wrangler', 'workflows', 'instances', 'describe', WORKFLOW_NAME, INSTANCE_ID, '--truncate-output-limit', '20000'],
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

function optionalHeader(output, label) {
	return output.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
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
		const type = block.match(/^\s+Type:\s+(.+)$/m)?.[1]?.trim();
		const success = block.match(/^\s+Success:\s+(.+)$/m)?.[1]?.trim();
		const sleeping = /\bSleeping\b/i.test(type ?? '');
		if (!name || (!success && !sleeping)) continue;
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
			success: success ?? 'Sleeping',
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

function assertSearchIndexReadiness(readiness, label) {
	assert.equal(readiness.configReady, true, `${label} AI Search metadata config`);
	assert.deepEqual(readiness.indexed, readiness.expected, `${label} indexed counts by kind`);
	assert.equal(readiness.ownedStatuses.completed, readiness.expected.total, `${label} completed owned items`);
	for (const state of ['queued', 'running', 'error', 'outdated', 'skipped']) {
		assert.equal(readiness.ownedStatuses[state], 0, `${label} owned ${state} items`);
	}
}

function assertUtcTimestamp(value, label) {
	assert.equal(typeof value, 'string', `${label} type`);
	assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,6})?Z$/, `${label} format`);
	assert.equal(Number.isNaN(Date.parse(value)), false, `${label} value`);
}

function assertResumeCompletion(steps, versionId, lastSuccessfulStep) {
	assert.equal(versionId, RESUME_VERSION_ID, 'resume Workflow version');
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
	assert.equal(Number(lease.rebuildEpoch), RESUME_REBUILD_EPOCH, 'resume generation epoch');

	const readiness = parsedStepOutput(
		steps.findLast((step) => /^load-search-index-readiness-\d+-\d+$/.test(step.name)),
		'resume terminal readiness',
	);
	assertSearchIndexReadiness(readiness, 'resume');

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

function numberedSteps(steps, pattern, label) {
	const matches = steps.flatMap((step) => {
		const match = step.name.match(pattern);
		return match ? [{ index: Number(match[1]), step }] : [];
	});
	assert.equal(
		matches.every((entry) => Number.isSafeInteger(entry.index) && entry.index >= 0),
		true,
		`${label} indices`,
	);
	matches.sort((left, right) => left.index - right.index);
	return matches;
}

function assertExactStepRange(matches, first, last, label) {
	assert.equal(matches.length, last - first + 1, `${label} step count`);
	assert.deepEqual(
		matches.map((entry) => entry.index),
		Array.from({ length: last - first + 1 }, (_, offset) => first + offset),
		`${label} step range`,
	);
}

function exactStep(steps, pattern, label) {
	const matches = steps.filter((step) => pattern.test(step.name));
	assert.equal(matches.length, 1, `${label} step count`);
	return matches[0];
}

function assertStepOrder(steps, orderedSteps, label) {
	const positions = orderedSteps.map(({ pattern, stepLabel }) => {
		const step = exactStep(steps, pattern, `${label} ${stepLabel}`);
		const position = steps.indexOf(step);
		assert.notEqual(position, -1, `${label} ${stepLabel} position`);
		return position;
	});
	assert.deepEqual(
		positions,
		[...positions].sort((left, right) => left - right),
		`${label} execution order`,
	);
}

function assertResumeCorpusAndDelta(steps) {
	const corpus = numberedSteps(steps, /^sync-corpus-page-(\d+)-\d+$/, 'resume corpus');
	assertExactStepRange(corpus, 365, 643, 'resume corpus');
	const corpusTerminal = parsedStepOutput(corpus.at(-1)?.step, 'resume corpus terminal page');
	assert.equal(corpusTerminal.done, true, 'resume corpus terminal done');
	assert.equal(Number(corpusTerminal.uploaded), 0, 'resume corpus terminal uploaded');

	const delta = numberedSteps(steps, /^sync-corpus-delta-page-(\d+)-\d+$/, 'resume delta');
	assertExactStepRange(delta, 0, 2, 'resume delta');
	const deltaOutputs = delta.map(({ step }, index) => parsedStepOutput(step, `resume delta page ${index}`));
	assert.equal(
		deltaOutputs.reduce((total, result) => total + Number(result.uploaded), 0),
		59,
		'resume delta uploads',
	);
	assert.equal(deltaOutputs.at(-1)?.done, true, 'resume delta terminal done');
	assert.equal(Number(deltaOutputs.at(-1)?.uploaded), 0, 'resume delta terminal uploaded');
}

function assertResumePrunePass(steps, pass, expectedDeleted) {
	const pageCount = Number(
		parsedStepOutput(
			steps.find((step) => step.name === `load-search-item-page-count-${pass}-1`),
			`resume prune pass ${pass} page count`,
		),
	);
	assert.equal(pageCount, 644, `resume prune pass ${pass} page count`);
	const batches = steps
		.flatMap((step) => {
			const match = step.name.match(new RegExp(`^prune-search-item-pages-${pass}-(\\d+)-(\\d+)-\\d+$`));
			return match ? [{ first: Number(match[1]), last: Number(match[2]), step }] : [];
		})
		.sort((left, right) => left.first - right.first);
	assert.equal(batches.length, 65, `resume prune pass ${pass} batch count`);
	assert.equal(batches[0]?.first, 1, `resume prune pass ${pass} first page`);
	assert.equal(batches.at(-1)?.last, pageCount, `resume prune pass ${pass} last page`);
	for (const [index, batch] of batches.entries()) {
		assert.equal(batch.last - batch.first < 10, true, `resume prune pass ${pass} batch ${index} width`);
		if (index > 0) {
			assert.equal(batch.first, batches[index - 1].last + 1, `resume prune pass ${pass} batch ${index} continuity`);
		}
	}
	const deleted = batches.reduce(
		(total, batch, index) => total + Number(parsedStepOutput(batch.step, `resume prune pass ${pass} batch ${index}`)),
		0,
	);
	assert.equal(deleted, expectedDeleted, `resume prune pass ${pass} deleted items`);
}

function assertResumeReadinessTimeout(steps, versionId, status, lastSuccessfulStep, workflowError) {
	assert.equal(versionId, RESUME_VERSION_ID, 'readiness-timeout source Workflow version');
	assert.equal(status, 'errored', 'readiness-timeout source terminal status');
	assert.equal(
		lastSuccessfulStep,
		`load-search-index-readiness-${RESUME_FINAL_READINESS_ATTEMPT}-1`,
		'readiness-timeout source final successful step',
	);
	assert.match(
		workflowError ?? '',
		new RegExp(`^Error: ${READINESS_TIMEOUT_ERROR_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
		'readiness-timeout source terminal error',
	);
	assert.equal(
		steps.some((step) => /^mark-search-index-generation-ready-\d+$/.test(step.name)),
		false,
		'readiness-timeout source must not publish readiness',
	);

	const source = parsedStepOutput(
		steps.find((step) => /^verify-errored-search-rebuild-source-\d+$/.test(step.name)),
		'readiness-timeout original source verification',
	);
	assert.equal(source.status, 'errored', 'readiness-timeout original source status');
	const startedAt = parsedStepOutput(
		steps.find((step) => /^capture-search-rebuild-started-at-\d+$/.test(step.name)),
		'readiness-timeout delta boundary',
	);
	assert.equal(startedAt, RESUME_STARTED_AT, 'readiness-timeout original delta boundary');
	const lease = parsedStepOutput(
		steps.find((step) => /^begin-search-index-generation-\d+$/.test(step.name)),
		'readiness-timeout generation lease',
	);
	assert.equal(Number(lease.rebuildEpoch), RESUME_REBUILD_EPOCH, 'readiness-timeout generation epoch');

	assertResumeCorpusAndDelta(steps);
	assertResumePrunePass(steps, 0, 16);
	assertResumePrunePass(steps, 1, 0);
	const readinessSteps = numberedSteps(steps, /^load-search-index-readiness-(\d+)-\d+$/, 'readiness-timeout observations');
	assertExactStepRange(readinessSteps, 0, RESUME_FINAL_READINESS_ATTEMPT, 'readiness-timeout observations');
	const terminalReadiness = parsedStepOutput(readinessSteps.at(-1)?.step, 'readiness-timeout terminal observation');
	assert.equal(terminalReadiness.configReady, true, 'readiness-timeout AI Search metadata config');
	assert.deepEqual(terminalReadiness.expected, RESUME_TERMINAL_EXPECTED, 'readiness-timeout expected identity counts');
	assert.deepEqual(terminalReadiness.ownedStatuses, RESUME_TERMINAL_OWNED_STATUSES, 'readiness-timeout exact owned status snapshot');
	assert.equal(terminalReadiness.indexed, null, 'readiness-timeout index remains unsettled');
	assert.equal(
		Object.values(terminalReadiness.ownedStatuses).reduce((total, count) => total + Number(count), 0),
		terminalReadiness.expected.total,
		'readiness-timeout owned status total',
	);
	assert.ok(
		terminalReadiness.ownedStatuses.queued + terminalReadiness.ownedStatuses.running + terminalReadiness.ownedStatuses.outdated > 0,
		'readiness-timeout must still have transient work remaining',
	);
	return {
		source,
		startedAt,
		rebuildEpoch: Number(lease.rebuildEpoch),
		terminalReadiness,
		workflowError,
	};
}

function repairTargetDigest(targets) {
	const canonical = [...targets]
		.sort((left, right) => (left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0))
		.map((target) => [target.itemId, target.resourceId, target.status, target.error].join('|'))
		.join('\n');
	return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function repairTargetSnapshot(targets) {
	const sortedTargets = [...targets].sort((left, right) =>
		left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0,
	);
	return {
		counts: {
			error: sortedTargets.filter((target) => target.status === 'error').length,
			outdated: sortedTargets.filter((target) => target.status === 'outdated').length,
			total: sortedTargets.length,
		},
		digest: repairTargetDigest(sortedTargets),
		targets: sortedTargets,
	};
}

function assertRepairTargetSnapshot(snapshot, label) {
	assert.equal(typeof snapshot, 'object', `${label} snapshot`);
	assert.equal(snapshot.counts.error + snapshot.counts.outdated, snapshot.counts.total, `${label} count total`);
	assert.equal(snapshot.targets.length, snapshot.counts.total, `${label} target count`);
	assert.equal(repairTargetDigest(snapshot.targets), snapshot.digest, `${label} target digest`);
	assert.deepEqual(
		snapshot.targets.map((target) => target.resourceId),
		[...snapshot.targets].map((target) => target.resourceId).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
		`${label} target ordering`,
	);
	assert.equal(new Set(snapshot.targets.map((target) => target.itemId)).size, snapshot.targets.length, `${label} unique item ids`);
	assert.equal(new Set(snapshot.targets.map((target) => target.resourceId)).size, snapshot.targets.length, `${label} unique resource ids`);
	for (const [index, target] of snapshot.targets.entries()) {
		assert.match(target.itemId, /^[0-9a-f]{32}$/, `${label} target ${index} item id`);
		assert.match(
			target.resourceId,
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			`${label} target ${index} resource id`,
		);
		assert.ok(target.status === 'error' || target.status === 'outdated', `${label} target ${index} repair status`);
		assert.equal(typeof target.error, 'string', `${label} target ${index} error type`);
		if (target.status === 'error') assert.notEqual(target.error.trim(), '', `${label} target ${index} error`);
		assertUtcTimestamp(target.lastSeenAt, `${label} target ${index} last-seen`);
	}
	return snapshot;
}

function assertInitialRepairTargetSnapshot(snapshot, label) {
	assertRepairTargetSnapshot(snapshot, label);
	assert.deepEqual(snapshot.counts, { error: 1, outdated: 29, total: 30 }, `${label} exact counts`);
	assert.equal(snapshot.digest, READINESS_INITIAL_REPAIR_DIGEST, `${label} pinned digest`);
	return snapshot;
}

function assertRepairSyncResult(result, snapshot, label) {
	assert.equal(result.requested, snapshot.targets.length, `${label} requested count`);
	assert.equal(result.requestedDigest, snapshot.digest, `${label} requested digest`);
	assert.equal(result.results.length, snapshot.targets.length, `${label} result count`);
	for (const [index, synced] of result.results.entries()) {
		const target = snapshot.targets[index];
		assert.ok(synced.action === 'synced' || synced.action === 'already-advanced', `${label} result ${index} action`);
		assert.equal(synced.itemId, target.itemId, `${label} result ${index} item id`);
		assert.equal(synced.resourceId, target.resourceId, `${label} result ${index} resource id`);
		assert.ok(
			['completed', 'error', 'skipped', 'queued', 'running', 'outdated'].includes(synced.status),
			`${label} result ${index} status`,
		);
		if (synced.action === 'already-advanced') {
			assert.ok(['completed', 'queued', 'running'].includes(synced.status), `${label} result ${index} advanced status`);
		} else {
			assert.notEqual(synced.status, 'skipped', `${label} result ${index} synced status`);
		}
		assert.ok(synced.error === null || typeof synced.error === 'string', `${label} result ${index} error`);
	}
	return result;
}

function assertReadinessContinuationCompletion(steps, versionId, lastSuccessfulStep) {
	assert.equal(versionId, READINESS_VERSION_ID, 'readiness continuation Workflow version');
	assert.match(lastSuccessfulStep, /^mark-search-index-generation-ready-\d+$/, 'readiness continuation final ready step');

	const allowedStepPatterns = [
		/^verify-readiness-timeout-source-\d+$/,
		/^inspect-search-index-repair-targets-preclaim-\d+$/,
		/^claim-search-index-readiness-continuation-\d+$/,
		/^reverify-readiness-timeout-source-\d+$/,
		/^inspect-search-index-repair-targets-postclaim-\d+$/,
		/^inspect-search-index-repair-targets-\d+-\d+$/,
		/^sync-search-index-repair-targets-\d+-\d+-\d+$/,
		/^wait-search-index-repair-0-\d+$/,
		/^load-search-index-readiness-\d+-\d+$/,
		/^wait-search-index-readiness-\d+-\d+$/,
		/^mark-search-index-generation-ready-\d+$/,
	];
	for (const step of steps) {
		assert.equal(
			allowedStepPatterns.some((pattern) => pattern.test(step.name)),
			true,
			`readiness continuation unexpected step ${step.name}`,
		);
	}

	const sourceBeforeClaim = parsedStepOutput(
		exactStep(steps, /^verify-readiness-timeout-source-\d+$/, 'readiness continuation source preclaim'),
		'readiness continuation source preclaim',
	);
	const sourceAfterClaim = parsedStepOutput(
		exactStep(steps, /^reverify-readiness-timeout-source-\d+$/, 'readiness continuation source postclaim'),
		'readiness continuation source postclaim',
	);
	assert.deepEqual(sourceAfterClaim, sourceBeforeClaim, 'readiness continuation source error remained stable across claim');
	assert.equal(sourceBeforeClaim.instanceId, RESUME_INSTANCE_ID, 'readiness continuation source instance');
	assert.equal(sourceBeforeClaim.status, 'errored', 'readiness continuation source status');
	assert.equal(sourceBeforeClaim.error?.name, 'Error', 'readiness continuation source error name');
	assert.match(
		sourceBeforeClaim.error?.message ?? '',
		new RegExp(`^${READINESS_TIMEOUT_ERROR_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
		'readiness continuation source error',
	);

	const repairTargetsBeforeClaim = assertInitialRepairTargetSnapshot(
		parsedStepOutput(
			exactStep(steps, /^inspect-search-index-repair-targets-preclaim-\d+$/, 'readiness continuation repair preclaim'),
			'readiness continuation repair preclaim',
		),
		'readiness continuation repair preclaim',
	);
	const claim = parsedStepOutput(
		exactStep(steps, /^claim-search-index-readiness-continuation-\d+$/, 'readiness continuation claim'),
		'readiness continuation claim',
	);
	assert.equal(claim.generation, 3, 'readiness continuation generation');
	assert.equal(claim.generationKey, 'canonical-3-kind', 'readiness continuation generation key');
	assert.equal(Number(claim.sourceRebuildEpoch), RESUME_REBUILD_EPOCH, 'readiness continuation source epoch');
	assert.equal(Number(claim.rebuildEpoch), READINESS_REBUILD_EPOCH, 'readiness continuation claimed epoch');
	assertUtcTimestamp(claim.startedAt, 'readiness continuation claim timestamp');

	const repairTargetsAfterClaim = assertRepairTargetSnapshot(
		parsedStepOutput(
			exactStep(steps, /^inspect-search-index-repair-targets-postclaim-\d+$/, 'readiness continuation repair postclaim'),
			'readiness continuation repair postclaim',
		),
		'readiness continuation repair postclaim',
	);
	const initialItemToResource = new Map(repairTargetsBeforeClaim.targets.map((target) => [target.itemId, target.resourceId]));
	for (const target of repairTargetsAfterClaim.targets) {
		assert.equal(initialItemToResource.get(target.itemId), target.resourceId, 'readiness continuation repair postclaim pinned target');
	}
	const repairSnapshots = new Map([[0, repairTargetsBeforeClaim]]);
	const retryTargetSteps = numberedSteps(steps, /^inspect-search-index-repair-targets-(\d+)-\d+$/, 'readiness continuation repair retries');
	if (retryTargetSteps.length > 0) {
		assertExactStepRange(retryTargetSteps, 1, retryTargetSteps.length, 'readiness continuation repair retries');
	}
	assert.ok(retryTargetSteps.length < READINESS_MAX_REPAIR_ROUNDS, 'readiness continuation bounded repair retries');
	for (const { index, step } of retryTargetSteps) {
		const snapshot = assertRepairTargetSnapshot(
			parsedStepOutput(step, `readiness continuation repair retry ${index}`),
			`readiness continuation repair retry ${index}`,
		);
		for (const target of snapshot.targets) {
			assert.equal(
				initialItemToResource.get(target.itemId),
				target.resourceId,
				`readiness continuation repair retry ${index} pinned target`,
			);
		}
		repairSnapshots.set(index, snapshot);
	}
	const repairSyncSteps = steps
		.flatMap((step) => {
			const match = step.name.match(/^sync-search-index-repair-targets-(\d+)-(\d+)-\d+$/);
			return match ? [{ repairRound: Number(match[1]), batch: Number(match[2]), step }] : [];
		})
		.sort((left, right) => left.repairRound - right.repairRound || left.batch - right.batch);
	for (const [repairRound, snapshot] of repairSnapshots) {
		const expectedBatchCount = Math.ceil(snapshot.targets.length / 5);
		const roundBatches = repairSyncSteps.filter((entry) => entry.repairRound === repairRound);
		assert.deepEqual(
			roundBatches.map((entry) => entry.batch),
			Array.from({ length: expectedBatchCount }, (_, batch) => batch),
			`readiness continuation repair round ${repairRound} batch range`,
		);
		for (const { batch, step } of roundBatches) {
			const batchSnapshot = repairTargetSnapshot(snapshot.targets.slice(batch * 5, batch * 5 + 5));
			assertRepairSyncResult(
				parsedStepOutput(step, `readiness continuation repair round ${repairRound} batch ${batch}`),
				batchSnapshot,
				`readiness continuation repair round ${repairRound} batch ${batch}`,
			);
		}
	}
	assert.equal(
		repairSyncSteps.every((entry) => repairSnapshots.has(entry.repairRound)),
		true,
		'readiness continuation repair sync rounds',
	);
	exactStep(steps, /^wait-search-index-repair-0-\d+$/, 'readiness continuation initial repair wait');

	const readinessSteps = numberedSteps(steps, /^load-search-index-readiness-(\d+)-\d+$/, 'readiness continuation observations');
	assert.ok(readinessSteps.length > 0, 'readiness continuation observation');
	assertExactStepRange(readinessSteps, 0, readinessSteps.length - 1, 'readiness continuation observations');
	assert.ok(readinessSteps.length <= 144, 'readiness continuation observation limit');
	const readinessSleeps = numberedSteps(steps, /^wait-search-index-readiness-(\d+)-\d+$/, 'readiness continuation waits');
	assert.equal(readinessSleeps.length, readinessSteps.length - 1, 'readiness continuation wait count');
	if (readinessSleeps.length > 0) {
		assertExactStepRange(readinessSleeps, 0, readinessSleeps.length - 1, 'readiness continuation waits');
	}
	const readiness = parsedStepOutput(readinessSteps.at(-1)?.step, 'readiness continuation terminal observation');
	assertSearchIndexReadiness(readiness, 'readiness continuation');
	const generationReadiness = parsedStepOutput(
		exactStep(steps, /^mark-search-index-generation-ready-\d+$/, 'readiness continuation generation readiness'),
		'readiness continuation generation readiness',
	);
	assertUtcTimestamp(generationReadiness.readyAt, 'readiness continuation ready timestamp');
	assertStepOrder(
		steps,
		[
			{ pattern: /^verify-readiness-timeout-source-\d+$/, stepLabel: 'source preclaim' },
			{ pattern: /^inspect-search-index-repair-targets-preclaim-\d+$/, stepLabel: 'repair preclaim' },
			{ pattern: /^claim-search-index-readiness-continuation-\d+$/, stepLabel: 'lease claim' },
			{ pattern: /^reverify-readiness-timeout-source-\d+$/, stepLabel: 'source postclaim' },
			{ pattern: /^inspect-search-index-repair-targets-postclaim-\d+$/, stepLabel: 'repair postclaim' },
			{ pattern: /^sync-search-index-repair-targets-0-0-\d+$/, stepLabel: 'initial repair sync' },
			{ pattern: /^mark-search-index-generation-ready-\d+$/, stepLabel: 'generation ready' },
		],
		'readiness continuation fence',
	);
	return {
		checkpoint: READINESS_CHECKPOINT_KEY,
		source: {
			beforeClaim: sourceBeforeClaim,
			afterClaim: sourceAfterClaim,
		},
		claim,
		repair: {
			beforeClaim: repairTargetsBeforeClaim,
			afterClaim: repairTargetsAfterClaim,
			rounds: repairSnapshots.size,
			batches: repairSyncSteps.length,
		},
		readiness,
		generationReadiness,
	};
}

function databaseUrl() {
	const value = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL;
	if (!value) throw new Error('Set a direct database URL before strict search-rebuild validation');
	const url = new URL(value);
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

async function assertSearchIndexDurableState({ label, ready, rebuildEpoch, status }) {
	const client = new pg.Client({ connectionString: databaseUrl() });
	await client.connect();
	try {
		const result = await client.query(
			`SELECT generation, generation_key, status, rebuild_epoch, ready_at
			   FROM search_index_states
			  WHERE index_name = 'public-corpus'`,
		);
		assert.equal(result.rowCount, 1, `${label} durable generation row`);
		const [state] = result.rows;
		assert.equal(state.generation, 3, `${label} durable generation`);
		assert.equal(state.generation_key, 'canonical-3-kind', `${label} durable generation key`);
		assert.equal(state.status, status, `${label} durable generation status`);
		assert.equal(Number(state.rebuild_epoch), rebuildEpoch, `${label} durable generation epoch`);
		if (ready) assert.ok(state.ready_at, `${label} durable ready timestamp`);
		else assert.equal(state.ready_at, null, `${label} durable ready timestamp`);
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
const workflowError = optionalHeader(output, 'Error');
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
assert.deepEqual(failedSteps, [], 'Workflow failed steps');
let readinessTimeoutEvidence = null;
let resumeEvidence = null;
let readinessContinuationEvidence = null;
let durableState = null;
if (EXPECT_READINESS_TIMEOUT) {
	assert.equal(instanceId, RESUME_INSTANCE_ID, 'readiness-timeout source instance id');
	readinessTimeoutEvidence = assertResumeReadinessTimeout(steps, versionId, status, lastSuccessfulStep, workflowError);
	durableState = await assertSearchIndexDurableState({
		label: 'readiness-timeout source',
		ready: false,
		rebuildEpoch: RESUME_REBUILD_EPOCH,
		status: 'rebuilding',
	});
} else {
	assert.ok(
		NON_FAILURE_STATUSES.has(status),
		`Workflow entered ${status}: ${JSON.stringify({
			lastSuccessfulStep,
			completedPage,
			failedSteps,
			retry,
		})}`,
	);
	if (!ALLOW_IN_PROGRESS) {
		assert.equal(status, 'complete', 'Workflow terminal completion');
		assert.equal(workflowError, null, 'completed Workflow error');
		if (instanceId === RESUME_INSTANCE_ID) {
			resumeEvidence = assertResumeCompletion(steps, versionId, lastSuccessfulStep);
			durableState = await assertSearchIndexDurableState({
				label: 'resume',
				ready: true,
				rebuildEpoch: resumeEvidence.rebuildEpoch,
				status: 'ready',
			});
		} else if (instanceId === READINESS_INSTANCE_ID) {
			readinessContinuationEvidence = assertReadinessContinuationCompletion(steps, versionId, lastSuccessfulStep);
			durableState = await assertSearchIndexDurableState({
				label: 'readiness continuation',
				ready: true,
				rebuildEpoch: READINESS_REBUILD_EPOCH,
				status: 'ready',
			});
		}
	}
}

console.info({
	event: EXPECT_READINESS_TIMEOUT
		? 'search_rebuild_readiness_timeout_validated'
		: ALLOW_IN_PROGRESS
			? 'search_rebuild_progress_validated'
			: 'search_rebuild_completion_validated',
	workflowName,
	instanceId,
	versionId,
	status,
	workflowError,
	lastSuccessfulStep,
	completedPage,
	runningStep,
	failedSteps,
	retry,
	readinessTimeoutEvidence,
	resumeEvidence,
	readinessContinuationEvidence,
	durableState,
});
