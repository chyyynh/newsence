/**
 * Scraper Comparison Test: Cheerio vs Playwright
 *
 * Scrapes a set of URLs with both cheerio (local, Node) and Playwright
 * (via deployed/dev worker endpoint), then saves results as markdown
 * files in test/snapshots/ for visual diffing.
 *
 * Prerequisites:
 *   - For Playwright: worker must be running (`pnpm dev`) or deployed
 *   - Set WORKER_BASE_URL env var to override (default: http://localhost:8787)
 *
 * Run:
 *   pnpm test:compare
 *   WORKER_BASE_URL=https://your-worker.workers.dev pnpm test:compare
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScrapedContent } from '../src/domain/scrapers';
import { scrapeWebPage } from '../src/domain/scrapers';

const WORKER_BASE_URL = process.env.WORKER_BASE_URL || 'http://localhost:8787';
const SNAPSHOT_DIR = join(process.cwd(), 'test', 'snapshots');

// ── Test URLs ──────────────────────────────────────────────
// Stable, accessible pages with different structures:
//   - Wikipedia article (SSR, structured content)
//   - MDN docs page (SSR, technical content)
//   - GitHub releases page (SPA-ish, dynamic content)
const TEST_URLS = [
	'https://en.wikipedia.org/wiki/Web_scraping',
	'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
	'https://github.com/nicehash/NiceHashQuickMiner/releases',
];

// ── Helpers ────────────────────────────────────────────────

function slugify(url: string): string {
	return new URL(url).pathname
		.replace(/^\/|\/$/g, '')
		.replace(/[^a-z0-9]+/gi, '-')
		.slice(0, 80);
}

function toMarkdown(label: string, url: string, result: ScrapedContent, ms: number): string {
	const lines = [
		`# ${result.title}`,
		'',
		`> **Scraper**: ${label}  `,
		`> **URL**: ${url}  `,
		`> **Time**: ${ms}ms  `,
		`> **Content length**: ${result.content.length} chars  `,
		`> **Site**: ${result.siteName ?? '—'}  `,
		`> **Author**: ${result.author ?? '—'}  `,
		`> **Published**: ${result.publishedDate ?? '—'}  `,
		`> **OG Image**: ${result.ogImageUrl ?? '—'}  `,
		`> **Summary**: ${result.summary ?? '—'}`,
		'',
		'---',
		'',
		result.content,
	];
	return lines.join('\n');
}

interface ScrapeResult {
	ok: boolean;
	data?: ScrapedContent;
	ms: number;
	error?: string;
}

async function scrapeCheerio(url: string): Promise<ScrapeResult> {
	const start = Date.now();
	try {
		const data = await scrapeWebPage(url);
		return { ok: true, data, ms: Date.now() - start };
	} catch (e) {
		return { ok: false, ms: Date.now() - start, error: String(e) };
	}
}

async function scrapePlaywright(url: string): Promise<ScrapeResult> {
	const start = Date.now();
	try {
		const endpoint = `${WORKER_BASE_URL}/scrape?url=${encodeURIComponent(url)}&mode=playwright`;
		const res = await fetch(endpoint, { signal: AbortSignal.timeout(30_000) });
		if (!res.ok) return { ok: false, ms: Date.now() - start, error: `HTTP ${res.status}` };

		const json = (await res.json()) as {
			url: string;
			results: {
				playwright?: { chars: number; title: string; content: string; ms: number } | { error: string };
			};
		};

		const pw = json.results.playwright;
		if (!pw || 'error' in pw) {
			return { ok: false, ms: Date.now() - start, error: pw ? pw.error : 'no playwright result' };
		}

		return {
			ok: true,
			data: { title: pw.title, content: pw.content, siteName: undefined, author: undefined, publishedDate: undefined },
			ms: pw.ms,
		};
	} catch (e) {
		return { ok: false, ms: Date.now() - start, error: String(e) };
	}
}

// ── Per-URL comparison ─────────────────────────────────────

interface CompareRow {
	url: string;
	cheerio: { chars: number; ms: number; ok: boolean };
	playwright: { chars: number; ms: number; ok: boolean };
}

function saveSnapshot(slug: string, label: string, ext: string, url: string, result: ScrapeResult): void {
	if (result.ok && result.data) {
		const md = toMarkdown(label, url, result.data, result.ms);
		writeFileSync(join(SNAPSHOT_DIR, `${slug}.${ext}.md`), md);
		console.info(`  ${ext}:${' '.repeat(12 - ext.length)}${result.data.content.length} chars, ${result.ms}ms`);
	} else {
		console.warn(`  ${ext}:${' '.repeat(12 - ext.length)}FAILED — ${result.error}`);
	}
}

async function compareUrl(url: string): Promise<CompareRow> {
	const slug = slugify(url);
	console.info(`\n── ${url}`);

	const [cheerio, playwright] = await Promise.all([scrapeCheerio(url), scrapePlaywright(url)]);

	saveSnapshot(slug, 'cheerio (readability+cheerio)', 'cheerio', url, cheerio);
	saveSnapshot(slug, 'playwright (browser)', 'playwright', url, playwright);

	return {
		url: new URL(url).pathname.slice(0, 50),
		cheerio: { chars: cheerio.data?.content.length ?? 0, ms: cheerio.ms, ok: cheerio.ok },
		playwright: { chars: playwright.data?.content.length ?? 0, ms: playwright.ms, ok: playwright.ok },
	};
}

function printSummary(rows: CompareRow[]): void {
	console.info('\n=== Comparison Summary ===\n');
	for (const r of rows) {
		const cStr = r.cheerio.ok ? `${r.cheerio.chars} chars (${r.cheerio.ms}ms)` : 'FAIL';
		const pStr = r.playwright.ok ? `${r.playwright.chars} chars (${r.playwright.ms}ms)` : 'FAIL';
		console.info(`  ${r.url}`);
		console.info(`    cheerio:    ${cStr}`);
		console.info(`    playwright: ${pStr}`);
	}
	console.info(`\nSnapshots saved to: ${SNAPSHOT_DIR}/`);
	console.info('Compare: diff test/snapshots/<slug>.cheerio.md test/snapshots/<slug>.playwright.md');
}

// ── Test ───────────────────────────────────────────────────

describe('Scraper Comparison: Cheerio vs Playwright', () => {
	if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

	it(
		'scrape test URLs and save markdown snapshots',
		async () => {
			const rows: CompareRow[] = [];
			for (const url of TEST_URLS) {
				rows.push(await compareUrl(url));
			}

			printSummary(rows);

			const cheerioOk = rows.filter((r) => r.cheerio.ok).length;
			expect(cheerioOk).toBeGreaterThan(0);
		},
		{ timeout: 120_000 },
	);
});
