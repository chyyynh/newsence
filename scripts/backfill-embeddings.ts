/**
 * Backfill embeddings with enriched text (title + summary + content).
 * Uses deployed core worker /embed endpoint + direct DB connection.
 *
 * Usage:
 *   npx tsx scripts/backfill-embeddings.ts              # start from beginning
 *   npx tsx scripts/backfill-embeddings.ts --offset 2300 # resume from offset
 */

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { prepareArticleTextForEmbedding, normalizeVector } from '../src/infra/embedding';

const EMBEDDING_URL = 'https://newsence-core.chinyuhsu1023.workers.dev/embed';
const BATCH_SIZE = 5;
const EMBED_BATCH_SIZE = 5;
const SLEEP_BETWEEN_BATCHES_MS = 2000; // 2s pause between batches to reduce DB pressure

interface ArticleRow {
	id: string;
	title: string;
	title_cn: string | null;
	summary: string | null;
	summary_cn: string | null;
	content: string | null;
	content_cn: string | null;
	tags: string[] | null;
	keywords: string[] | null;
}

interface EmbeddingResponse {
	embeddings: number[][];
}

function getConnectionString(): string {
	const envPath = path.resolve(import.meta.dirname, '../../../frontend/.env.local');
	const content = fs.readFileSync(envPath, 'utf-8');
	for (const line of content.split('\n')) {
		if (line.startsWith('DIRECT_URL=')) {
			return line.slice('DIRECT_URL='.length).replace(/^["']|["']$/g, '');
		}
	}
	throw new Error('DIRECT_URL not found');
}

function parseOffset(): number {
	const idx = process.argv.indexOf('--offset');
	if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
	return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
	const res = await fetch(EMBEDDING_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ texts }),
	});
	if (!res.ok) throw new Error(`Embed error: ${res.status} ${await res.text()}`);
	const data: EmbeddingResponse = await res.json();
	return data.embeddings.map(normalizeVector);
}

async function main() {
	const connStr = getConnectionString()
		.replace(/&?sslrootcert=system/, '')
		.replace(/sslmode=verify-full/, 'sslmode=require');

	const db = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
	await db.connect();

	const {
		rows: [{ count }],
	} = await db.query('SELECT COUNT(*) FROM articles');
	const total = parseInt(count, 10);
	const startOffset = parseOffset();
	console.log(`Total: ${total} articles, starting from offset ${startOffset}`);
	console.log(`Config: batch=${BATCH_SIZE}, sleep=${SLEEP_BETWEEN_BATCHES_MS}ms`);

	let offset = startOffset;
	let processed = 0;
	let failed = 0;
	const t0 = Date.now();

	while (offset < total) {
		const { rows: articles } = await db.query<ArticleRow>(
			'SELECT id, title, title_cn, summary, summary_cn, content, content_cn, tags, keywords FROM articles ORDER BY id OFFSET $1 LIMIT $2',
			[offset, BATCH_SIZE],
		);
		if (articles.length === 0) break;

		const texts = articles.map((a) => prepareArticleTextForEmbedding(a));

		for (let i = 0; i < articles.length; i += EMBED_BATCH_SIZE) {
			const batch = articles.slice(i, i + EMBED_BATCH_SIZE);
			const batchTexts = texts.slice(i, i + EMBED_BATCH_SIZE);
			try {
				const embeddings = await fetchEmbeddings(batchTexts);
				for (let j = 0; j < batch.length; j++) {
					const vecStr = `[${embeddings[j].join(',')}]`;
					await db.query('UPDATE articles SET embedding = $1 WHERE id = $2', [vecStr, batch[j].id]);
					processed++;
				}
			} catch (err) {
				console.error(`\n  Batch error at offset ${offset + i}:`, String(err));
				failed += batch.length;
			}
		}

		offset += articles.length;
		const sec = (Date.now() - t0) / 1000;
		const rate = processed / sec;
		const remaining = total - offset;
		const eta = rate > 0 ? (remaining / rate / 60).toFixed(1) : '?';
		process.stdout.write(`\r  ${processed + startOffset}/${total} done, ${failed} failed | ${rate.toFixed(1)}/s | ETA ${eta}m`);

		// Pause between batches to let DB breathe
		if (remaining > 0) await sleep(SLEEP_BETWEEN_BATCHES_MS);
	}

	console.log(`\nFinished: ${processed} processed, ${failed} failed, ${((Date.now() - t0) / 1000 / 60).toFixed(1)}m`);
	await db.end();
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
