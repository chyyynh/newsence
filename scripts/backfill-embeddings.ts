/**
 * Backfill embeddings with enriched text (title + summary + content).
 * Drop HNSW index before running, rebuild after.
 *
 * Usage:
 *   npx tsx scripts/backfill-embeddings.ts              # start from beginning
 *   npx tsx scripts/backfill-embeddings.ts --offset 2590 # resume
 */

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { normalizeVector, prepareArticleTextForEmbedding } from '../src/infra/embedding';

const EMBEDDING_URL = 'https://newsence-core.chinyuhsu1023.workers.dev/embed';
const BATCH_SIZE = 20;
const CONCURRENCY = 4; // parallel embedding API calls

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

async function fetchEmbedding(text: string): Promise<number[]> {
	const res = await fetch(EMBEDDING_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text }),
	});
	if (!res.ok) throw new Error(`Embed error: ${res.status}`);
	const data: EmbeddingResponse = await res.json();
	return normalizeVector(data.embeddings[0]);
}

async function processArticle(db: Client, article: ArticleRow): Promise<boolean> {
	const text = prepareArticleTextForEmbedding(article);
	const embedding = await fetchEmbedding(text);
	const vecStr = `[${embedding.join(',')}]`;
	await db.query('UPDATE articles SET embedding = $1 WHERE id = $2', [vecStr, article.id]);
	return true;
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
	console.log(`Total: ${total} | offset: ${startOffset} | concurrency: ${CONCURRENCY}`);

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

		// Process CONCURRENCY articles in parallel
		for (let i = 0; i < articles.length; i += CONCURRENCY) {
			const chunk = articles.slice(i, i + CONCURRENCY);
			const results = await Promise.allSettled(chunk.map((a) => processArticle(db, a)));
			for (const r of results) {
				if (r.status === 'fulfilled') processed++;
				else {
					failed++;
					console.error(`\n  Error:`, r.reason);
				}
			}
		}

		offset += articles.length;
		const sec = (Date.now() - t0) / 1000;
		const rate = processed / sec;
		const eta = rate > 0 ? ((total - offset) / rate / 60).toFixed(1) : '?';
		process.stdout.write(`\r  ${offset}/${total} | ${rate.toFixed(1)}/s | ETA ${eta}m | failed: ${failed}`);
	}

	console.log(`\nDone: ${processed} ok, ${failed} failed, ${((Date.now() - t0) / 1000 / 60).toFixed(1)}m`);
	await db.end();
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
