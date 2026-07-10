#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_NAME = 'newsence-monitor-workflow';
const MODES = new Set(['stalled', 'missing-content']);

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

function directDatabaseUrl(value) {
	const url = new URL(value);
	url.searchParams.delete('pgbouncer');
	if (url.searchParams.get('sslrootcert') === 'system') url.searchParams.delete('sslrootcert');
	return url.toString();
}

const mode = option('--mode', 'stalled');
if (!MODES.has(mode)) throw new Error(`--mode must be one of: ${[...MODES].join(', ')}`);
const limit = positiveInteger(option('--limit', '100'), '--limit', 1000);
const concurrency = positiveInteger(option('--concurrency', '4'), '--concurrency', 16);
const dryRun = process.argv.includes('--dry-run');
const databaseUrl = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
if (!databaseUrl) throw new Error('DATABASE_URL or DIRECT_URL is required');

const candidates = {
	stalled: {
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
	},
	'missing-content': {
		from: `resources r
			JOIN resource_translations original
			  ON original.resource_id = r.id
			 AND original.lang = r.original_lang`,
		where: `
			r.scope = 'corpus'
			AND r.type IN ('web', 'rss', 'twitter', 'hackernews')
			AND r.url IS NOT NULL
			AND r.enrichment_status IN ('enriched', 'failed')
			AND r.updated_at < NOW() - INTERVAL '15 minutes'
			AND NULLIF(BTRIM(original.content), '') IS NULL`,
		orderBy: `
			EXISTS (SELECT 1 FROM library item WHERE item.resource_id = r.id) DESC,
			COALESCE(r.published_date, r.created_at) DESC,
			r.id DESC`,
	},
}[mode];

function triggerWorkflow(resourceId) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(
			'pnpm',
			['exec', 'wrangler', 'workflows', 'trigger', WORKFLOW_NAME, JSON.stringify({ resourceId }), '--config', 'wrangler.jsonc'],
			{ cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
		);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(stderr.trim() || stdout.trim() || `Wrangler exited with ${code}`));
		});
	});
}

async function runPool(rows) {
	const failures = [];
	let nextIndex = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
			while (nextIndex < rows.length) {
				const index = nextIndex++;
				const row = rows[index];
				try {
					await triggerWorkflow(row.id);
					process.stdout.write(`[${index + 1}/${rows.length}] queued ${row.id}\n`);
				} catch (error) {
					failures.push(row.id);
					process.stderr.write(`[${index + 1}/${rows.length}] failed ${row.id}: ${String(error)}\n`);
				}
			}
		}),
	);
	return failures;
}

const client = new Client({ connectionString: directDatabaseUrl(databaseUrl) });
await client.connect();
try {
	const selectSql = `
		SELECT r.id::text AS id, r.enrichment_status AS status, r.updated_at
		FROM ${candidates.from}
		WHERE ${candidates.where}
		ORDER BY ${candidates.orderBy}
		LIMIT $1`;
	if (dryRun) {
		const preview = await client.query(selectSql, [limit]);
		process.stdout.write(`${JSON.stringify({ mode, dryRun: true, candidates: preview.rowCount, rows: preview.rows }, null, 2)}\n`);
	} else {
		await client.query('BEGIN');
		const claimed = await client.query(
			`WITH candidates AS (
				SELECT r.id
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
			RETURNING resource.id::text AS id`,
			[limit],
		);
		await client.query('COMMIT');

		const failures = await runPool(claimed.rows);
		if (failures.length) {
			await client.query(
				`UPDATE resources
				 SET enrichment_status = 'failed', updated_at = NOW()
				 WHERE id = ANY($1::uuid[])`,
				[failures],
			);
		}
		process.stdout.write(
			`${JSON.stringify({ mode, claimed: claimed.rowCount, queued: claimed.rowCount - failures.length, failed: failures.length })}\n`,
		);
		if (failures.length) process.exitCode = 1;
	}
} catch (error) {
	await client.query('ROLLBACK').catch(() => undefined);
	throw error;
} finally {
	await client.end();
}
