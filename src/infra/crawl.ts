// ─────────────────────────────────────────────────────────────
// Cloudflare Browser Rendering /crawl API
// Replaces Readability + Cheerio + Turndown pipeline with a
// single API call that returns markdown + HTML.
// ─────────────────────────────────────────────────────────────

import { logInfo } from './log';

interface CrawlRecord {
	url: string;
	status: string;
	markdown?: string;
	html?: string;
	metadata: { status: number; title: string; url: string };
}

interface CrawlStartResponse {
	success: boolean;
	result: string; // job ID
}

interface CrawlPollResponse {
	result: { status: string; records: CrawlRecord[] };
}

export interface CrawlPageResult {
	markdown: string;
	title: string;
	ogImageUrl: string | null;
	description: string | null;
	siteName: string;
	author: string | null;
	publishedDate: string | null;
	finalUrl: string;
}

const CRAWL_API = 'https://api.cloudflare.com/client/v4/accounts';
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30; // 60s max

// ── Metadata extraction (regex on <head>) ───────────────

function extractMeta(html: string, property: string): string | null {
	const head = html.slice(0, 20_000);
	// <meta property="X" content="Y"> or <meta name="X" content="Y">
	const p1 = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
	// <meta content="Y" property="X"> (reversed attribute order)
	const p2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, 'i');
	return head.match(p1)?.[1] ?? head.match(p2)?.[1] ?? null;
}

function extractMetadataFromHtml(html: string, url: string): Omit<CrawlPageResult, 'markdown' | 'finalUrl'> {
	const title =
		extractMeta(html, 'og:title') ?? extractMeta(html, 'twitter:title') ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? '';

	let ogImageUrl = extractMeta(html, 'og:image') ?? extractMeta(html, 'og:image:url') ?? extractMeta(html, 'twitter:image');

	if (ogImageUrl && !ogImageUrl.startsWith('http')) {
		try {
			ogImageUrl = new URL(ogImageUrl, new URL(url).origin).toString();
		} catch {
			ogImageUrl = null;
		}
	}

	return {
		title,
		ogImageUrl: ogImageUrl ?? null,
		description: extractMeta(html, 'og:description') ?? extractMeta(html, 'description'),
		siteName: extractMeta(html, 'og:site_name') ?? new URL(url).hostname,
		author: extractMeta(html, 'author') ?? extractMeta(html, 'article:author'),
		publishedDate: extractMeta(html, 'article:published_time') ?? html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] ?? null,
	};
}

// ── Crawl API calls ─────────────────────────────────────

async function startCrawlJob(accountId: string, apiToken: string, url: string): Promise<string> {
	const res = await fetch(`${CRAWL_API}/${accountId}/browser-rendering/crawl`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			url,
			limit: 1,
			formats: ['markdown', 'html'],
			render: true,
			rejectResourceTypes: ['image', 'media', 'font', 'stylesheet'],
			gotoOptions: { waitUntil: 'networkidle2', timeout: 15_000 },
		}),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Crawl API start failed: HTTP ${res.status} ${body.slice(0, 200)}`);
	}

	const data = (await res.json()) as CrawlStartResponse;
	if (!data.success || typeof data.result !== 'string') {
		throw new Error(`Crawl API start failed: unexpected response`);
	}

	return data.result;
}

async function pollCrawlJob(accountId: string, apiToken: string, jobId: string): Promise<CrawlRecord> {
	for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

		const res = await fetch(`${CRAWL_API}/${accountId}/browser-rendering/crawl/${jobId}?limit=1`, {
			headers: { Authorization: `Bearer ${apiToken}` },
		});

		if (!res.ok) throw new Error(`Crawl API poll failed: HTTP ${res.status}`);

		const data = (await res.json()) as CrawlPollResponse;
		const { status, records } = data.result;

		if (status === 'completed' && records.length > 0) return records[0];
		if (status !== 'running') throw new Error(`Crawl job ${status}`);
	}

	throw new Error(`Crawl job timed out after ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s`);
}

// ── Public API ──────────────────────────────────────────

export async function crawlPage(url: string, accountId: string, apiToken: string): Promise<CrawlPageResult> {
	logInfo('CRAWL', 'Starting', { url });

	const jobId = await startCrawlJob(accountId, apiToken, url);
	logInfo('CRAWL', 'Job created', { jobId });

	const record = await pollCrawlJob(accountId, apiToken, jobId);

	const metadata = record.html
		? extractMetadataFromHtml(record.html, record.url)
		: {
				title: record.metadata.title,
				ogImageUrl: null,
				description: null,
				siteName: new URL(url).hostname,
				author: null,
				publishedDate: null,
			};

	logInfo('CRAWL', 'Completed', { url, chars: record.markdown?.length ?? 0 });

	return {
		markdown: record.markdown ?? '',
		title: metadata.title || record.metadata.title || '',
		ogImageUrl: metadata.ogImageUrl,
		description: metadata.description,
		siteName: metadata.siteName,
		author: metadata.author,
		publishedDate: metadata.publishedDate,
		finalUrl: record.url || url,
	};
}
