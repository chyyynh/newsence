#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = resolve(ROOT, 'node_modules/.bin/wrangler');
const WORKFLOW_NAME = 'newsence-monitor-workflow';
const INSTANCE_PREFIX = 'missing-content';
const TERMINAL_STATUSES = new Set(['complete', 'errored', 'terminated']);

function option(name, fallback) {
	const inline = process.argv.find((value) => value.startsWith(`${name}=`));
	if (inline) return inline.slice(name.length + 1);
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

function positiveInteger(value, name, maximum) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new Error(`${name} must be an integer between 1 and ${maximum}`);
	}
	return parsed;
}

function nonNegativeInteger(value, name, maximum) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
		throw new Error(`${name} must be an integer between 0 and ${maximum}`);
	}
	return parsed;
}

function databaseConnectionUrl(value) {
	const url = new URL(value);
	url.searchParams.delete('pgbouncer');
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

function createRunId() {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
	return `${timestamp}-${crypto.randomUUID().slice(0, 4)}`;
}

function validateRunId(value) {
	if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new Error('--run-id/--reconcile contains invalid characters or is too long');
	return value;
}

function runStartedAt(runId) {
	const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(runId);
	if (!match) throw new Error(`Cannot derive start time from run id ${runId}`);
	return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
}

function instancePrefix(runId) {
	return `${INSTANCE_PREFIX}-${runId}-`;
}

function instanceId(runId, resourceId) {
	return `${instancePrefix(runId)}${resourceId}`;
}

function resourceIdFromInstance(runId, id) {
	const prefix = instancePrefix(runId);
	const resourceId = id.startsWith(prefix) ? id.slice(prefix.length) : '';
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resourceId) ? resourceId : undefined;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');
const noWait = process.argv.includes('--no-wait');
const reconcileRunId = option('--reconcile');
const limit = positiveInteger(option('--limit', '100'), '--limit', 1000);
const batchSize = positiveInteger(option('--batch-size', '50'), '--batch-size', 100);
const delaySeconds = nonNegativeInteger(option('--delay', '2'), '--delay', 3600);
const waitMinutes = nonNegativeInteger(option('--wait-minutes', '45'), '--wait-minutes', 1440);
if (dryRun && (all || reconcileRunId)) throw new Error('--dry-run cannot be combined with --all or --reconcile');
if (reconcileRunId && (all || noWait)) throw new Error('--reconcile cannot be combined with --all or --no-wait');

const CANDIDATE_FROM = `resources r
	JOIN resource_translations original
	  ON original.resource_id = r.id
	 AND original.lang = r.original_lang`;
const CANDIDATE_WHERE = `
	r.scope = 'corpus'
	AND r.type IN ('web', 'rss', 'twitter', 'hackernews')
	AND r.url IS NOT NULL
	AND r.enrichment_status IN ('enriched', 'failed')
	AND r.updated_at < NOW() - INTERVAL '15 minutes'
	AND NULLIF(BTRIM(original.content), '') IS NULL`;
const CANDIDATE_ORDER = `
	EXISTS (SELECT 1 FROM library item WHERE item.resource_id = r.id) DESC,
	COALESCE(r.published_date, r.created_at) DESC,
	r.id DESC`;

function wranglerJson(args) {
	const result = spawnSync(WRANGLER, args, { cwd: ROOT, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `Wrangler exited with ${result.status}`);
	}
	return JSON.parse(result.stdout);
}

function loadCloudflareCredentials() {
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? wranglerJson(['whoami', '--json']).accounts?.[0]?.id;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? wranglerJson(['auth', 'token', '--json']).token;
	if (!accountId || !apiToken) throw new Error('Cloudflare account ID or API token is unavailable');
	return { accountId, apiToken };
}

function retryDelay(attempt) {
	return Math.min(60_000, 5_000 * 2 ** attempt);
}

async function cloudflareRequest(credentials, path, init = {}) {
	for (let attempt = 0; attempt <= 8; attempt++) {
		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${credentials.apiToken}`,
				...(init.body ? { 'Content-Type': 'application/json' } : {}),
				...init.headers,
			},
		});
		const payload = await response.json().catch(() => undefined);
		if (response.ok && payload?.success === true) return payload;
		if ((response.status === 429 || response.status >= 500) && attempt < 8) {
			const retryAfterSeconds = Number.parseFloat(response.headers.get('retry-after') ?? '');
			const delayMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : retryDelay(attempt);
			process.stderr.write(`Cloudflare API ${response.status}; retrying in ${delayMs / 1000}s\n`);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
			continue;
		}
		throw new Error(`Cloudflare API failed (${response.status}): ${JSON.stringify(payload?.errors ?? payload ?? 'invalid response')}`);
	}
}

async function claimRows(pool, count) {
	const client = await pool.connect();
	try {
		await client.query('RESET statement_timeout');
		await client.query('BEGIN');
		const result = await client.query(
			`WITH candidates AS (
				SELECT r.id, r.enrichment_status AS previous_status
				FROM ${CANDIDATE_FROM}
				WHERE ${CANDIDATE_WHERE}
				ORDER BY ${CANDIDATE_ORDER}
				LIMIT $1
				FOR UPDATE OF r SKIP LOCKED
			)
			UPDATE resources resource
			SET enrichment_status = 'pending', updated_at = NOW()
			FROM candidates
			WHERE resource.id = candidates.id
			RETURNING resource.id::text AS id, candidates.previous_status AS status`,
			[count],
		);
		await client.query('COMMIT');
		return result.rows;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

async function restoreRows(pool, rows) {
	if (!rows.length) return;
	const values = [];
	const placeholders = rows.map((row, index) => {
		values.push(row.id, row.status);
		return `($${index * 2 + 1}::uuid, $${index * 2 + 2}::text)`;
	});
	await pool.query(
		`UPDATE resources resource
		 SET enrichment_status = restored.status, updated_at = NOW()
		 FROM (VALUES ${placeholders.join(', ')}) AS restored(id, status)
		 WHERE resource.id = restored.id`,
		values,
	);
}

async function queueBatch(credentials, runId, rows) {
	const payload = await cloudflareRequest(credentials, `/workflows/${WORKFLOW_NAME}/instances/batch`, {
		method: 'POST',
		body: JSON.stringify(
			rows.map((row) => ({
				instance_id: instanceId(runId, row.id),
				params: { resourceId: row.id },
			})),
		),
	});
	if (payload.result?.length !== rows.length) throw new Error('Cloudflare created an unexpected number of workflow instances');
}

async function queueCandidates(pool, credentials, runId) {
	const queued = [];
	let remaining = all ? Number.POSITIVE_INFINITY : limit;
	while (remaining > 0) {
		const rows = await claimRows(pool, Math.min(batchSize, remaining));
		if (!rows.length) break;
		try {
			await queueBatch(credentials, runId, rows);
			queued.push(...rows);
			process.stdout.write(`Queued ${queued.length}${all ? '' : `/${limit}`} resources for run ${runId}\n`);
		} catch (error) {
			await restoreRows(pool, rows);
			throw error;
		}
		remaining -= rows.length;
		if (rows.length < Math.min(batchSize, remaining + rows.length)) break;
		if (delaySeconds) await new Promise((resolvePromise) => setTimeout(resolvePromise, delaySeconds * 1000));
	}
	return queued;
}

async function listRunInstances(credentials, runId) {
	const found = [];
	const dateStart = new Date(runStartedAt(runId).getTime() - 5 * 60_000).toISOString();
	let cursor;
	do {
		const query = new URLSearchParams({ date_start: dateStart, direction: 'asc', per_page: '100' });
		if (cursor) query.set('cursor', cursor);
		const payload = await cloudflareRequest(credentials, `/workflows/${WORKFLOW_NAME}/instances?${query}`);
		found.push(...(payload.result ?? []).filter((instance) => instance.id.startsWith(instancePrefix(runId))));
		cursor = payload.result_info?.cursor || undefined;
	} while (cursor);
	return found;
}

async function waitForRun(credentials, runId, expectedCount) {
	const deadline = Date.now() + waitMinutes * 60_000;
	let instances = [];
	do {
		instances = await listRunInstances(credentials, runId);
		const terminalCount = instances.filter((instance) => TERMINAL_STATUSES.has(instance.status)).length;
		process.stdout.write(`Run ${runId}: ${terminalCount}/${expectedCount ?? instances.length} terminal\n`);
		if (instances.length && terminalCount === instances.length && (expectedCount === undefined || instances.length >= expectedCount)) {
			return instances;
		}
		if (Date.now() >= deadline) return instances;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000));
	} while (Date.now() < deadline);
	return instances;
}

async function mapWithConcurrency(values, concurrency, mapper) {
	const results = new Array(values.length);
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, async () => {
			while (nextIndex < values.length) {
				const index = nextIndex++;
				results[index] = await mapper(values[index]);
			}
		}),
	);
	return results;
}

async function getInstance(credentials, id) {
	const payload = await cloudflareRequest(credentials, `/workflows/${WORKFLOW_NAME}/instances/${encodeURIComponent(id)}`);
	return payload.result;
}

function isPermanentlyUnavailable(error) {
	const message = error?.message ?? String(error ?? '');
	const transientClientStatuses = new Set([408, 409, 423, 424, 425, 429]);
	const statuses = [...message.matchAll(/\bHTTP\s+(\d{3})\b/gi)].map((match) => Number.parseInt(match[1] ?? '', 10));
	if (
		statuses.some((status) => (status >= 400 && status < 500 && !transientClientStatuses.has(status)) || status === 525 || status === 526)
	) {
		return true;
	}
	return /\bnot found\b|too many redirects|video not playable on any client|cannot build twitter thread resource from empty tweets|unsupported response content type|only http\(s\) urls are allowed|url must not include credentials|has no text to embed/i.test(
		message,
	);
}

async function deleteResources(pool, ids) {
	if (!ids.length) return 0;
	const result = await pool.query('DELETE FROM resources WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
	return result.rowCount;
}

async function completedResourcesStillMissingContent(pool, ids) {
	if (!ids.length) return [];
	const result = await pool.query(
		`SELECT r.id::text AS id
		 FROM resources r
		 JOIN resource_translations original
		   ON original.resource_id = r.id
		  AND original.lang = r.original_lang
		 WHERE r.id = ANY($1::uuid[])
		   AND NULLIF(BTRIM(original.content), '') IS NULL`,
		[ids],
	);
	return result.rows.map((row) => row.id);
}

async function markTerminatedRowsFailed(pool, ids) {
	if (!ids.length) return 0;
	const result = await pool.query(
		`UPDATE resources
		 SET enrichment_status = 'failed', updated_at = NOW()
		 WHERE id = ANY($1::uuid[])
		   AND enrichment_status = 'pending'`,
		[ids],
	);
	return result.rowCount;
}

async function reconcileRun(pool, credentials, runId, instances) {
	const terminal = instances.filter((instance) => TERMINAL_STATUSES.has(instance.status));
	const completedIds = terminal
		.filter((instance) => instance.status === 'complete')
		.map((instance) => resourceIdFromInstance(runId, instance.id))
		.filter(Boolean);
	const failedInstances = terminal.filter((instance) => instance.status === 'errored');
	const failedDetails = await mapWithConcurrency(failedInstances, 12, (instance) => getInstance(credentials, instance.id));
	const permanentlyUnavailableIds = failedDetails.flatMap((details, index) => {
		const resourceId = resourceIdFromInstance(runId, failedInstances[index].id);
		return isPermanentlyUnavailable(details.error) && resourceId ? [resourceId] : [];
	});

	const emptyCompletedIds = await completedResourcesStillMissingContent(pool, completedIds);
	const deleteIds = [...new Set([...permanentlyUnavailableIds.filter(Boolean), ...emptyCompletedIds])];
	const deleted = await deleteResources(pool, deleteIds);
	const terminatedIds = terminal
		.filter((instance) => instance.status === 'terminated')
		.map((instance) => resourceIdFromInstance(runId, instance.id))
		.filter(Boolean);
	const terminatedMarkedFailed = await markTerminatedRowsFailed(pool, terminatedIds);
	const active = instances.length - terminal.length;
	const summary = {
		runId,
		instances: instances.length,
		complete: completedIds.length,
		errored: failedInstances.length,
		terminated: terminatedIds.length,
		active,
		deleted,
		deletedPermanent: permanentlyUnavailableIds.filter(Boolean).length,
		deletedEmpty: emptyCompletedIds.length,
		transientFailed: failedInstances.length - permanentlyUnavailableIds.filter(Boolean).length,
		terminatedMarkedFailed,
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}

const pool = new Pool({
	connectionString: databaseConnectionUrl(databaseUrl),
	max: 2,
	idleTimeoutMillis: 10_000,
});

try {
	if (dryRun) {
		const preview = await pool.query(
			`SELECT r.id::text AS id, r.type, r.url, r.enrichment_status AS status
			 FROM ${CANDIDATE_FROM}
			 WHERE ${CANDIDATE_WHERE}
			 ORDER BY ${CANDIDATE_ORDER}
			 LIMIT $1`,
			[limit],
		);
		process.stdout.write(`${JSON.stringify({ dryRun: true, candidates: preview.rowCount, rows: preview.rows }, null, 2)}\n`);
	} else {
		const credentials = loadCloudflareCredentials();
		const runId = validateRunId(reconcileRunId ?? option('--run-id', createRunId()));
		if (reconcileRunId) {
			const instances = await listRunInstances(credentials, runId);
			if (!instances.length) throw new Error(`No workflow instances found for run ${runId}`);
			await reconcileRun(pool, credentials, runId, instances);
		} else {
			const queued = await queueCandidates(pool, credentials, runId);
			process.stdout.write(`${JSON.stringify({ runId, queued: queued.length })}\n`);
			if (!noWait && queued.length) {
				const instances = await waitForRun(credentials, runId, queued.length);
				const summary = await reconcileRun(pool, credentials, runId, instances);
				if (summary.active || summary.instances < queued.length) process.exitCode = 2;
			}
		}
	}
} finally {
	await pool.end();
}
