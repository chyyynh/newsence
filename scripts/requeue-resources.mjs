#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = resolve(ROOT, 'node_modules/.bin/wrangler');
const WORKFLOW_NAME = 'newsence-monitor-workflow';
const MODES = new Set(['stalled']);
const WORKFLOW_BATCH_SIZE = 100;

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

const mode = option('--mode', 'stalled');
if (!MODES.has(mode)) throw new Error(`--mode must be one of: ${[...MODES].join(', ')}`);
const limit = positiveInteger(option('--limit', '100'), '--limit', 1000);
const concurrency = positiveInteger(option('--concurrency', '1'), '--concurrency', 16);
const delaySeconds = nonNegativeInteger(option('--delay', '60'), '--delay', 3600);
const dryRun = process.argv.includes('--dry-run');
const all = process.argv.includes('--all');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (dryRun && all) throw new Error('--dry-run and --all cannot be used together');

const candidates = {
	from: 'resources r',
	where: `
			r.type IN ('web', 'rss', 'twitter', 'youtube', 'hackernews', 'pdf', 'paper')
			AND (
				r.enrichment_status = 'pending' AND r.updated_at < NOW() - INTERVAL '15 minutes'
				OR (
					r.enrichment_status = 'failed'
					AND r.updated_at < NOW() - INTERVAL '30 minutes'
					AND NOT (
						r.scope = 'corpus'
						AND r.type IN ('web', 'rss', 'twitter', 'hackernews')
						AND r.url IS NOT NULL
						AND EXISTS (
							SELECT 1
							FROM resource_translations original
							WHERE original.resource_id = r.id
							  AND original.lang = r.original_lang
							  AND NULLIF(BTRIM(original.content), '') IS NULL
						)
					)
				)
			)`,
	orderBy: 'r.updated_at ASC, r.id ASC',
};

function wranglerJson(args) {
	const result = spawnSync(WRANGLER, args, {
		cwd: ROOT,
		encoding: 'utf8',
	});
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

async function queryWithRetry(queryable, text, values) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await queryable.query(text, values);
		} catch (error) {
			if (attempt >= 8) throw error;
			const delayMs = retryDelay(attempt);
			process.stderr.write(`Database unavailable; retrying in ${delayMs / 1000}s: ${error.message}\n`);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
		}
	}
}

async function triggerWorkflowBatch(rows, credentials) {
	for (let attempt = 0; attempt <= 8; attempt++) {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/workflows/${WORKFLOW_NAME}/instances/batch`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${credentials.apiToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(
					rows.map((row) => ({
						params: {
							resourceId: row.id,
						},
					})),
				),
			},
		);
		const payload = await response.json().catch(() => undefined);
		if (response.ok && payload?.success === true && payload.result?.length === rows.length) return;
		if (response.status === 429 && attempt < 8) {
			const retryAfterSeconds = Number.parseFloat(response.headers.get('retry-after') ?? '');
			const delayMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : retryDelay(attempt);
			process.stderr.write(`Cloudflare rate limit; retrying ${rows.length} resources in ${delayMs / 1000}s\n`);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
			continue;
		}
		throw new Error(
			`Cloudflare batch trigger failed (${response.status}): ${JSON.stringify(payload?.errors ?? payload ?? 'invalid response')}`,
		);
	}
}

async function runPool(rows, credentials) {
	const batches = Array.from({ length: Math.ceil(rows.length / WORKFLOW_BATCH_SIZE) }, (_, index) =>
		rows.slice(index * WORKFLOW_BATCH_SIZE, (index + 1) * WORKFLOW_BATCH_SIZE),
	);
	const failures = [];
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
			while (nextIndex < batches.length) {
				const index = nextIndex++;
				const batch = batches[index];
				try {
					await triggerWorkflowBatch(batch, credentials);
					process.stdout.write(`[${index + 1}/${batches.length}] queued ${batch.length} resources\n`);
				} catch (error) {
					failures.push(...batch);
					process.stderr.write(`[${index + 1}/${batches.length}] failed ${batch.length} resources: ${String(error)}\n`);
				}
			}
		}),
	);
	return failures;
}

async function claimRows(pool) {
	const client = await pool.connect();
	try {
		await client.query('RESET statement_timeout');
		await client.query('BEGIN');
		const claimed = await client.query(
			`WITH candidates AS (
				SELECT r.id, r.enrichment_status AS previous_status
				FROM ${candidates.from}
				WHERE ${candidates.where}
				ORDER BY ${candidates.orderBy}
				LIMIT $1
				FOR UPDATE OF r SKIP LOCKED
			)
			UPDATE resources resource
			SET enrichment_status = 'pending', updated_at = NOW()
			FROM candidates
			WHERE resource.id = candidates.id
			RETURNING resource.id::text AS id, candidates.previous_status AS status`,
			[limit],
		);
		await client.query('COMMIT');
		return claimed.rows;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

async function poolQuery(pool, text, values) {
	const client = await pool.connect();
	let connectionError;
	try {
		await client.query('RESET statement_timeout');
		return await client.query(text, values);
	} catch (error) {
		connectionError = error;
		throw error;
	} finally {
		client.release(connectionError);
	}
}

async function claimSnapshotRows(client, rows) {
	if (!rows.length) return [];
	const values = [];
	const placeholders = rows.map((row, index) => {
		values.push(row.id, row.status);
		return `($${index * 2 + 1}::uuid, $${index * 2 + 2}::text)`;
	});
	const claimed = await queryWithRetry(
		client,
		`UPDATE resources resource
		 SET enrichment_status = 'pending', updated_at = NOW()
		 FROM (VALUES ${placeholders.join(', ')}) AS candidate(id, previous_status)
		 WHERE resource.id = candidate.id
		   AND resource.enrichment_status = candidate.previous_status
		 RETURNING resource.id::text AS id, candidate.previous_status AS status`,
		values,
	);
	return claimed.rows;
}

async function selectCursorPage(client, afterId) {
	const page = await queryWithRetry(
		client,
		`SELECT r.id::text AS id, r.enrichment_status AS status, r.updated_at
		 FROM ${candidates.from}
		 WHERE ${candidates.where}
		   AND ($1::uuid IS NULL OR r.id > $1::uuid)
		 ORDER BY r.id
		 LIMIT $2`,
		[afterId, limit],
	);
	return page.rows;
}

async function restoreFailures(client, failures) {
	if (!failures.length) return;
	const values = [];
	const placeholders = failures.map((row, index) => {
		values.push(row.id, row.status);
		return `($${index * 2 + 1}::uuid, $${index * 2 + 2}::text)`;
	});
	await queryWithRetry(
		client,
		`UPDATE resources resource
		 SET enrichment_status = failed.status, updated_at = NOW()
		 FROM (VALUES ${placeholders.join(', ')}) AS failed(id, status)
		 WHERE resource.id = failed.id`,
		values,
	);
}

async function claimAndQueueSelectedRows(client, rows, credentials) {
	const batches = Array.from({ length: Math.ceil(rows.length / WORKFLOW_BATCH_SIZE) }, (_, index) =>
		rows.slice(index * WORKFLOW_BATCH_SIZE, (index + 1) * WORKFLOW_BATCH_SIZE),
	);
	const totals = { claimed: 0, queued: 0, failed: 0, skipped: 0 };
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
			while (nextIndex < batches.length) {
				const index = nextIndex++;
				const selected = batches[index];
				const claimed = await claimSnapshotRows(client, selected);
				let failures = [];
				if (claimed.length) {
					try {
						await triggerWorkflowBatch(claimed, credentials);
						process.stdout.write(`[${index + 1}/${batches.length}] queued ${claimed.length} resources\n`);
					} catch (error) {
						failures = claimed;
						process.stderr.write(`[${index + 1}/${batches.length}] failed ${claimed.length} resources: ${String(error)}\n`);
					}
				}
				await restoreFailures(client, failures);
				totals.claimed += claimed.length;
				totals.queued += claimed.length - failures.length;
				totals.failed += failures.length;
				totals.skipped += selected.length - claimed.length;
			}
		}),
	);
	return totals;
}

const pool = new Pool({
	connectionString: databaseConnectionUrl(databaseUrl),
	max: 1,
	idleTimeoutMillis: 10_000,
});
const database = { query: (text, values) => poolQuery(pool, text, values) };
try {
	const selectSql = (limitSql = 'LIMIT $1', orderSql = `ORDER BY ${candidates.orderBy}`) => `
		SELECT r.id::text AS id, r.enrichment_status AS status, r.updated_at
		FROM ${candidates.from}
		WHERE ${candidates.where}
		${orderSql}
		${limitSql}`;
	if (dryRun) {
		const preview = await queryWithRetry(database, selectSql(), [limit]);
		process.stdout.write(`${JSON.stringify({ mode, dryRun: true, candidates: preview.rowCount, rows: preview.rows }, null, 2)}\n`);
	} else {
		const credentials = loadCloudflareCredentials();
		const totals = { selected: all ? 0 : undefined, claimed: 0, queued: 0, failed: 0, skipped: 0 };
		let cursor;
		while (true) {
			const selected = all ? await selectCursorPage(database, cursor) : undefined;
			if (selected?.length === 0) break;
			if (selected) {
				totals.selected += selected.length;
				cursor = selected.at(-1).id;
			}
			let page;
			if (selected) {
				page = await claimAndQueueSelectedRows(database, selected, credentials);
			} else {
				const claimed = await claimRows(pool);
				const failures = await runPool(claimed, credentials);
				await restoreFailures(database, failures);
				page = {
					claimed: claimed.length,
					queued: claimed.length - failures.length,
					failed: failures.length,
					skipped: 0,
				};
			}
			totals.claimed += page.claimed;
			totals.queued += page.queued;
			totals.failed += page.failed;
			totals.skipped += page.skipped;
			process.stdout.write(`${JSON.stringify({ mode, batch: page.claimed, ...totals })}\n`);
			if (!selected || page.failed || selected.length < limit) break;
			if (delaySeconds) {
				process.stdout.write(`Waiting ${delaySeconds}s before the next database batch\n`);
				await new Promise((resolvePromise) => setTimeout(resolvePromise, delaySeconds * 1000));
			}
		}
		if (totals.failed) process.exitCode = 1;
	}
} finally {
	await pool.end();
}
