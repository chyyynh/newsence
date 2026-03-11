/**
 * Scraper Test: Cloudflare Browser Rendering /crawl API
 *
 * Scrapes a set of URLs via the /test-scrape endpoint (which uses /crawl),
 * then saves results as markdown files in test/snapshots/ for review.
 *
 * Prerequisites:
 *   - Worker must be running (`pnpm dev`) or deployed
 *   - CF_ACCOUNT_ID and CF_API_TOKEN must be set in wrangler.jsonc
 *   - Set WORKER_BASE_URL env var to override (default: http://localhost:8787)
 *
 * Run:
 *   pnpm test:compare
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const SNAPSHOT_DIR = join(process.cwd(), 'test', 'snapshots');

const TEST_URLS = [
	'https://en.wikipedia.org/wiki/Web_scraping',
	'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
	'https://github.com/nicehash/NiceHashQuickMiner/releases',
];

function slugify(url: string): string {
	return new URL(url).pathname
		.replace(/^\/|\/$/g, '')
		.replace(/[^a-z0-9]+/gi, '-')
		.slice(0, 80);
}

async function scrapeCrawl(url: string): Promise<{ ok: boolean; chars: number; title: string; ms: number; error?: string }> {
	const start = Date.now();
	try {
		const endpoint = `${WORKER_BASE_URL}/scrape?url=${encodeURIComponent(url)}`;
		const res = await fetch(endpoint, { signal: AbortSignal.timeout(120_000) });
		if (!res.ok) return { ok: false, chars: 0, title: '', ms: Date.now() - start, error: `HTTP ${res.status}` };

		const json = (await res.json()) as {
			results: { crawl?: { chars: number; title: string; content: string; ms: number } | { error: string } };
		};

		const crawl = json.results.crawl;
		if (!crawl || 'error' in crawl) {
			return { ok: false, chars: 0, title: '', ms: Date.now() - start, error: crawl ? crawl.error : 'no result' };
		}

		writeFileSync(join(SNAPSHOT_DIR, `${slugify(url)}.crawl.md`), `# ${crawl.title}\n\n${crawl.content}`);
		return { ok: true, chars: crawl.chars, title: crawl.title, ms: crawl.ms };
	} catch (e) {
		return { ok: false, chars: 0, title: '', ms: Date.now() - start, error: String(e) };
	}
}

describe('Scraper: Cloudflare /crawl API', () => {
	if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

	it(
		'scrape test URLs via crawl API',
		async () => {
			const results = [];
			for (const url of TEST_URLS) {
				console.info(`\n── ${url}`);
				const r = await scrapeCrawl(url);
				console.info(`  ${r.ok ? `${r.chars} chars, ${r.ms}ms` : `FAIL: ${r.error}`}`);
				results.push(r);
			}

			console.info(`\nSnapshots saved to: ${SNAPSHOT_DIR}/`);
			expect(results.filter((r) => r.ok).length).toBeGreaterThan(0);
		},
		{ timeout: 300_000 },
	);
});
