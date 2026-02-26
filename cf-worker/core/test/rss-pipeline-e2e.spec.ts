/**
 * RSS Pipeline E2E Test
 *
 * Full pipeline: fetch RSS → parse → extract content → AI analysis → content translation.
 * No DB writes, no embeddings.
 *
 * Run: pnpm test:e2e
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { extractItemsFromFeed, extractRssFullContent, extractUrlFromItem, stripHtml } from '../src/app/schedule';
import { translateContent } from '../src/domain/processors';
import { scrapeWebPage } from '../src/domain/scrapers';
import { callGeminiForAnalysis } from '../src/infra/ai';
import type { Article } from '../src/models/types';

// ─────────────────────────────────────────────────────────────
// Env
// ─────────────────────────────────────────────────────────────

function stripJsonComments(str: string): string {
	let result = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < str.length; i++) {
		const ch = str[i];
		if (inString) {
			result += ch;
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
		} else if (ch === '"') {
			inString = true;
			result += ch;
		} else if (ch === '/' && str[i + 1] === '/') {
			while (i < str.length && str[i] !== '\n') i++;
		} else if (ch === '/' && str[i + 1] === '*') {
			i += 2;
			while (i < str.length && !(str[i] === '*' && str[i + 1] === '/')) i++;
			i++;
		} else {
			result += ch;
		}
	}
	return result;
}

function readWranglerVars(): Record<string, string> {
	const raw = readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf-8');
	const cleaned = stripJsonComments(raw).replace(/,\s*([\]}])/g, '$1');
	return JSON.parse(cleaned).vars;
}

const vars = readWranglerVars();
const supabase = createClient(vars.SUPABASE_URL, vars.SUPABASE_SERVICE_ROLE_KEY);
const apiKey = vars.OPENROUTER_API_KEY;
const parser = new XMLParser({ ignoreAttributes: false });
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

interface FeedResult {
	feed: string;
	url?: string;
	title?: string;
	contentSource: string;
	contentLength: number;
	rssContentAvailable: boolean;
	summary?: string;
	content?: string;
	// AI analysis fields
	aiStatus?: string;
	aiTags?: string[];
	aiCategory?: string;
	aiSummaryEn?: string;
	aiSummaryCn?: string;
	aiTitleCn?: string;
	// Content translation fields
	translateStatus?: string;
	contentCn?: string;
}

async function fetchWithTimeout(url: string, timeoutMs = 15_000): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			signal: controller.signal,
			headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
		});
	} finally {
		clearTimeout(timer);
	}
}

function buildArticle(feed: { name: string }, item: Record<string, any>, url: string, content: string): Article {
	return {
		id: 'test',
		title: String(item.title ?? 'N/A'),
		summary: stripHtml(item.description ?? item.summary ?? '') || null,
		content: content || null,
		url,
		source: feed.name,
		published_date: new Date().toISOString(),
		tags: [],
		keywords: [],
		source_type: 'rss',
	};
}

function preview(text: string | undefined | null, maxLen: number): string {
	if (!text) return '';
	return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

// ─────────────────────────────────────────────────────────────
// Test
// ─────────────────────────────────────────────────────────────

describe('RSS Pipeline E2E', () => {
	it(
		'full pipeline: fetch → extract → AI analysis → translate',
		async () => {
			// 1. Fetch real feeds from DB
			const { data: feeds, error } = await supabase.from('RssList').select('id, name, RSSLink, url, type');
			expect(error).toBeNull();

			const rssFeeds = (feeds ?? []).filter((f: { type: string }) => f.type === 'rss');
			console.log(`\nFound ${rssFeeds.length} RSS feeds\n`);
			expect(rssFeeds.length).toBeGreaterThan(0);

			const results: FeedResult[] = [];

			for (const feed of rssFeeds) {
				// 2. Fetch RSS XML
				let res: Response;
				try {
					res = await fetchWithTimeout(feed.RSSLink);
				} catch (e) {
					results.push({
						feed: feed.name,
						contentSource: `fetch_error: ${String(e).slice(0, 40)}`,
						contentLength: 0,
						rssContentAvailable: false,
					});
					continue;
				}

				if (!res.ok) {
					results.push({
						feed: feed.name,
						contentSource: `http_${res.status}`,
						contentLength: 0,
						rssContentAvailable: false,
					});
					continue;
				}

				// 3. Parse XML, pick first item
				let items: ReturnType<typeof extractItemsFromFeed>;
				try {
					items = extractItemsFromFeed(parser.parse(await res.text()));
				} catch (e) {
					results.push({
						feed: feed.name,
						contentSource: `parse_error: ${String(e).slice(0, 40)}`,
						contentLength: 0,
						rssContentAvailable: false,
					});
					continue;
				}

				if (!items.length) {
					results.push({ feed: feed.name, contentSource: 'no_items', contentLength: 0, rssContentAvailable: false });
					continue;
				}

				const item = items[0];
				const url = extractUrlFromItem(item);

				if (!url) {
					results.push({ feed: feed.name, contentSource: 'no_url', contentLength: 0, rssContentAvailable: false });
					continue;
				}

				// 4. Content extraction: RSS full content → web scrape fallback
				const rssContent = extractRssFullContent(item);
				let content = rssContent;
				let contentSource = 'rss_full_content';

				if (!content) {
					try {
						const scraped = await scrapeWebPage(url);
						content = scraped.content;
						contentSource = 'web_scrape';
					} catch {
						contentSource = 'scrape_failed';
					}
				}

				const summary = stripHtml(item.description ?? item.summary ?? '');

				const result: FeedResult = {
					feed: feed.name,
					url,
					title: String(item.title ?? 'N/A').slice(0, 60),
					contentSource,
					contentLength: content?.length ?? 0,
					rssContentAvailable: rssContent.length > 0,
					summary: summary.slice(0, 80),
					content: content || undefined,
				};

				// 5. AI analysis (skip if no content)
				if (content && content.length > 0) {
					try {
						const article = buildArticle(feed, item, url, content);
						const analysis = await callGeminiForAnalysis(article, apiKey);
						result.aiStatus = 'ok';
						result.aiTags = analysis.tags;
						result.aiCategory = analysis.category;
						result.aiSummaryEn = analysis.summary_en;
						result.aiSummaryCn = analysis.summary_cn;
						result.aiTitleCn = analysis.title_cn;
					} catch (e) {
						result.aiStatus = `error: ${String(e).slice(0, 40)}`;
					}
				} else {
					result.aiStatus = 'skipped (no content)';
				}

				// 6. Content translation (same condition as workflow: content > 100 chars)
				if (content && content.length > 100) {
					try {
						const contentCn = await translateContent(content, apiKey);
						if (contentCn) {
							result.translateStatus = 'ok';
							result.contentCn = contentCn;
						} else {
							result.translateStatus = 'empty response';
						}
					} catch (e) {
						result.translateStatus = `error: ${String(e).slice(0, 40)}`;
					}
				} else {
					result.translateStatus = 'skipped';
				}

				results.push(result);
			}

			// ── Report ──────────────────────────────────────────────

			console.log('\n=== Content Extraction ===\n');

			const sorted = [...results].sort((a, b) => a.contentSource.localeCompare(b.contentSource));

			console.table(
				sorted.map((r) => ({
					Feed: r.feed,
					Source: r.contentSource,
					Length: r.contentLength,
					'RSS?': r.rssContentAvailable ? 'Y' : '',
					Title: (r.title ?? '').slice(0, 40),
				})),
			);

			// Content extraction stats
			const bySource: Record<string, number> = {};
			for (const r of results) {
				const key = r.contentSource.startsWith('fetch_error') ? 'fetch_error' : r.contentSource;
				bySource[key] = (bySource[key] ?? 0) + 1;
			}
			console.log('\n--- Content Stats ---');
			for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
				console.log(`  ${source}: ${count}`);
			}

			const withContent = results.filter((r) => r.contentLength > 0);
			console.log(`\n${withContent.length}/${results.length} feeds produced content\n`);

			// AI analysis report
			console.log('\n=== AI Analysis ===\n');

			const aiResults = results.filter((r) => r.aiStatus);
			console.table(
				aiResults.map((r) => ({
					Feed: r.feed,
					AI: r.aiStatus,
					Category: r.aiCategory ?? '',
					Tags: r.aiTags?.join(', ') ?? '',
					'Title CN': preview(r.aiTitleCn, 30),
				})),
			);

			console.log('\n--- AI Summary Detail ---\n');
			for (const r of aiResults.filter((r) => r.aiStatus === 'ok')) {
				console.log(`[${r.feed}]`);
				console.log(`  EN: ${r.aiSummaryEn}`);
				console.log(`  CN: ${r.aiSummaryCn}`);
				console.log();
			}

			// Content + Translation report
			console.log('\n=== Content & Translation ===\n');

			for (const r of results.filter((r) => r.content)) {
				console.log(`${'─'.repeat(60)}`);
				console.log(`[${r.feed}] ${r.title}`);
				console.log(`  Source: ${r.contentSource} | Length: ${r.contentLength}`);
				console.log(`  Translate: ${r.translateStatus}`);
				console.log();
				console.log('  --- content (first 500 chars) ---');
				console.log(`  ${preview(r.content, 500)}`);
				console.log();
				if (r.contentCn) {
					console.log(`  --- content_cn (first 500 chars) ---`);
					console.log(`  ${preview(r.contentCn, 500)}`);
				}
				console.log();
			}

			// Translation stats
			const translateOk = results.filter((r) => r.translateStatus === 'ok').length;
			const translateSkipped = results.filter((r) => r.translateStatus === 'skipped').length;
			const translateFailed = results.filter((r) => r.translateStatus?.startsWith('error')).length;
			const translateEmpty = results.filter((r) => r.translateStatus === 'empty response').length;

			console.log('\n--- Translation Stats ---');
			console.log(`  ok: ${translateOk}  skipped: ${translateSkipped}  empty: ${translateEmpty}  failed: ${translateFailed}`);

			// AI stats
			const aiOk = aiResults.filter((r) => r.aiStatus === 'ok').length;
			const aiSkipped = aiResults.filter((r) => r.aiStatus?.startsWith('skipped')).length;
			const aiFailed = aiResults.filter((r) => r.aiStatus?.startsWith('error')).length;
			console.log('\n--- AI Stats ---');
			console.log(`  ok: ${aiOk}  skipped: ${aiSkipped}  failed: ${aiFailed}`);

			// Assertions
			expect(withContent.length).toBeGreaterThan(results.length * 0.3);
			expect(aiOk).toBeGreaterThan(0);
			expect(translateOk).toBeGreaterThan(0);
		},
		{ timeout: 600_000 },
	);
});
