import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { extractFromXml, type FeedEntry } from '@extractus/feed-extractor';
import { describe, expect, it } from 'vitest';
import type { ProcessorResult } from '../src/ingest/domain/ai-utils';
import { FEED_UA, fetchWithTimeout, normalizeUrl, readTextWithLimit } from '../src/shared/web';

declare module 'cloudflare:workers' {
	interface ProvidedEnv extends CoreEnv {}
}

const RSS_FEED_URL = 'https://blog.cloudflare.com/rss/';
const TWITTER_URL = 'https://x.com/CloudflareDev/status/1884324381155025017';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const PAPER_URL = 'https://arxiv.org/abs/1706.03762';
const PDF_URL = 'https://www.africau.edu/images/default/sample.pdf';
const FIXED_DATE = '2026-07-09T00:00:00.000Z';

type SourceDraft = {
	article: {
		url: string;
		title: string;
		source: string;
		publishedDate: string;
		summary: string;
		sourceType: string;
		content: string | null;
		platformMetadata: unknown | null;
		keywords?: string[];
		tags?: string[];
	};
};

type SmokeCase =
	| {
			name: string;
			target: { kind: 'source'; draft: SourceDraft };
			expectedArticleId: string;
			expectPaperEnrichment?: boolean;
	  }
	| {
			name: string;
			target: { kind: 'userFile'; rowId: string };
			shell: ReturnType<typeof savedUrlShell>;
			expectedArticleId: string;
			expectPaperEnrichment?: boolean;
	  };

function requireSmokeSecrets(): void {
	const names = ['KAITO_API_KEY', 'YOUTUBE_API_KEY', 'S2_API_KEY'] as const;
	const missing = names.filter((name) => {
		const value = env[name];
		return !value || value.startsWith('test-');
	});
	if (missing.length) {
		throw new Error(`Missing ${missing.join(', ')}. Add them to workers/core-worker/.dev.vars before running pnpm test:smoke.`);
	}
}

function savedUrlShell(name: string, url: string) {
	const host = new URL(url).hostname.replace(/^www\./, '');
	return {
		id: `smoke-${name}`,
		title: host,
		title_cn: null,
		summary: '',
		summary_cn: null,
		content: null,
		url,
		source: host,
		published_date: FIXED_DATE,
		tags: [],
		keywords: [],
		source_type: 'web',
		platform_metadata: { type: 'default', fetchedAt: FIXED_DATE, data: null },
		entities: null,
		has_content: false,
		storage_key: null,
		file_type: 'web',
	};
}

async function fetchRssDraft(): Promise<SourceDraft> {
	const response = await fetchWithTimeout(RSS_FEED_URL, {
		headers: {
			'User-Agent': FEED_UA,
			Accept: 'application/rss+xml, application/xml, text/xml, */*',
		},
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`RSS smoke feed failed: HTTP ${response.status}`);
	}

	const feed = extractFromXml(await readTextWithLimit(response, 3 * 1024 * 1024), {
		descriptionMaxLen: 0,
	});
	const entry = ((feed.entries ?? []) as FeedEntry[]).find((item) => item.link && item.title);
	if (!entry?.link || !entry.title) throw new Error('RSS smoke feed did not include a usable entry');

	const summary = (entry.description || '').trim();
	return {
		article: {
			url: normalizeUrl(entry.link),
			title: entry.title,
			source: 'Cloudflare Blog',
			publishedDate: entry.published ? new Date(entry.published).toISOString() : FIXED_DATE,
			summary,
			sourceType: 'rss',
			content: null,
			platformMetadata: null,
		},
	};
}

function expectAiResult(result: unknown, caseName: string): void {
	const processorResult = result as ProcessorResult;
	expect(processorResult?.updateData, `${caseName}: ai-analysis returned no updateData`).toBeTruthy();
	expect(
		processorResult.updateData.title_cn || processorResult.updateData.summary_cn || processorResult.updateData.content_cn,
		`${caseName}: ai-analysis did not produce translated fields`,
	).toEqual(expect.any(String));
}

async function runWorkflowSmoke(testCase: SmokeCase): Promise<void> {
	const workflowId = `smoke-${testCase.name}-${crypto.randomUUID()}`;
	const instance = await introspectWorkflowInstance(env.MONITOR_WORKFLOW, workflowId);

	try {
		await instance.modify(async (modifier) => {
			await modifier.disableSleeps();
			await modifier.disableRetryDelays();
			await modifier.mockStepResult({ name: 'sync-paper-graph' }, { edges: 0 });
			if (testCase.target.kind === 'source') {
				await modifier.mockStepResult({ name: 'insert-final-article' }, testCase.expectedArticleId);
			} else {
				await modifier.mockStepResult({ name: 'fetch-article-shell' }, testCase.shell);
				await modifier.mockStepResult({ name: 'update-db' }, testCase.expectedArticleId);
			}
		});

		await env.MONITOR_WORKFLOW.create({
			id: workflowId,
			params: { target: testCase.target },
		});

		if (testCase.target.kind === 'userFile') {
			await expect(instance.waitForStepResult({ name: 'acquire-content' }), `${testCase.name}: acquire-content`).resolves.toBeTruthy();
		}
		if (testCase.expectPaperEnrichment) {
			await expect(
				instance.waitForStepResult({ name: 'enrich-paper-metadata' }),
				`${testCase.name}: paper enrichment`,
			).resolves.toBeTruthy();
		}

		expectAiResult(await instance.waitForStepResult({ name: 'ai-analysis' }), testCase.name);
		const embedding = await instance.waitForStepResult({ name: 'generate-embedding' });
		expect(Array.isArray(embedding) ? embedding.length : 0, `${testCase.name}: embedding`).toBeGreaterThan(0);
		await expect(instance.waitForStatus('complete'), `${testCase.name}: workflow status`).resolves.not.toThrow();
		await expect(instance.getOutput(), `${testCase.name}: workflow output`).resolves.toEqual({
			success: true,
			article_id: testCase.expectedArticleId,
		});
	} finally {
		await instance.dispose();
	}
}

describe.sequential('NewsenceMonitorWorkflow smoke', () => {
	it('acquires RSS, Twitter, YouTube, paper, and PDF locally, runs AI, and skips DB writes', async () => {
		requireSmokeSecrets();

		const rssDraft = await fetchRssDraft();
		const cases: SmokeCase[] = [
			{
				name: 'rss',
				target: { kind: 'source', draft: rssDraft },
				expectedArticleId: 'smoke-rss',
			},
			{
				name: 'twitter',
				target: { kind: 'userFile', rowId: 'smoke-twitter' },
				shell: savedUrlShell('twitter', TWITTER_URL),
				expectedArticleId: 'smoke-twitter',
			},
			{
				name: 'youtube',
				target: { kind: 'userFile', rowId: 'smoke-youtube' },
				shell: savedUrlShell('youtube', YOUTUBE_URL),
				expectedArticleId: 'smoke-youtube',
			},
			{
				name: 'paper',
				target: { kind: 'userFile', rowId: 'smoke-paper' },
				shell: savedUrlShell('paper', PAPER_URL),
				expectedArticleId: 'smoke-paper',
				expectPaperEnrichment: true,
			},
			{
				name: 'pdf',
				target: { kind: 'userFile', rowId: 'smoke-pdf' },
				shell: savedUrlShell('pdf', PDF_URL),
				expectedArticleId: 'smoke-pdf',
			},
		];

		for (const smokeCase of cases) {
			await runWorkflowSmoke(smokeCase);
		}
	});
});
