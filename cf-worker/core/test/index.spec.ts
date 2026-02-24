import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getProcessor, isEmpty } from '../src/domain/processors';
import { detectPlatformType, extractHackerNewsId, extractTweetId, extractYouTubeId } from '../src/domain/scrapers';
import worker from '../src/index';
import { extractJson } from '../src/infra/ai';
import { normalizeVector, prepareArticleTextForEmbedding } from '../src/infra/embedding';
import { extractTitleFromHtml, isSocialMediaUrl, normalizeUrl } from '../src/infra/web';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// ═════════════════════════════════════════════════════════════
// Pure Function Unit Tests
// ═════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// domain/scrapers.ts — Platform Detection & ID Extraction
// ─────────────────────────────────────────────────────────────

describe('detectPlatformType', () => {
	it('detects YouTube URLs', () => {
		expect(detectPlatformType('https://www.youtube.com/watch?v=abc123')).toBe('youtube');
		expect(detectPlatformType('https://youtu.be/abc123')).toBe('youtube');
		expect(detectPlatformType('https://m.youtube.com/watch?v=abc123')).toBe('youtube');
	});

	it('detects Twitter/X URLs', () => {
		expect(detectPlatformType('https://twitter.com/user/status/123')).toBe('twitter');
		expect(detectPlatformType('https://x.com/user/status/123')).toBe('twitter');
		expect(detectPlatformType('https://www.x.com/user/status/123')).toBe('twitter');
		expect(detectPlatformType('https://mobile.twitter.com/user/status/123')).toBe('twitter');
	});

	it('detects HackerNews URLs', () => {
		expect(detectPlatformType('https://news.ycombinator.com/item?id=12345')).toBe('hackernews');
		expect(detectPlatformType('https://www.ycombinator.com/')).toBe('hackernews');
	});

	it('returns web for generic URLs', () => {
		expect(detectPlatformType('https://example.com/article')).toBe('web');
		expect(detectPlatformType('https://blog.openai.com/post')).toBe('web');
	});

	it('returns web for invalid URLs', () => {
		expect(detectPlatformType('not-a-url')).toBe('web');
		expect(detectPlatformType('')).toBe('web');
	});
});

describe('extractTweetId', () => {
	it('extracts from twitter.com status URL', () => {
		expect(extractTweetId('https://twitter.com/user/status/1234567890')).toBe('1234567890');
	});

	it('extracts from x.com status URL', () => {
		expect(extractTweetId('https://x.com/elonmusk/status/9876543210')).toBe('9876543210');
	});

	it('returns null for non-status URLs', () => {
		expect(extractTweetId('https://twitter.com/user')).toBeNull();
		expect(extractTweetId('https://example.com')).toBeNull();
	});
});

describe('extractYouTubeId', () => {
	it('extracts from ?v= parameter', () => {
		expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('extracts from youtu.be short URL', () => {
		expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('extracts from /embed/ URL', () => {
		expect(extractYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('extracts from /shorts/ URL', () => {
		expect(extractYouTubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('extracts from /v/ URL', () => {
		expect(extractYouTubeId('https://www.youtube.com/v/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('returns null for URLs without video ID', () => {
		expect(extractYouTubeId('https://www.youtube.com/channel/UCxyz')).toBeNull();
		expect(extractYouTubeId('https://example.com')).toBeNull();
	});
});

describe('extractHackerNewsId', () => {
	it('extracts item ID from HN URL', () => {
		expect(extractHackerNewsId('https://news.ycombinator.com/item?id=12345')).toBe('12345');
	});

	it('extracts ID when other params present', () => {
		expect(extractHackerNewsId('https://news.ycombinator.com/item?id=99999&p=2')).toBe('99999');
	});

	it('returns null when no id param', () => {
		expect(extractHackerNewsId('https://news.ycombinator.com/')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// infra/web.ts — URL Normalization & Helpers
// ─────────────────────────────────────────────────────────────

describe('normalizeUrl', () => {
	it('removes UTM tracking parameters', () => {
		const url = 'https://example.com/article?utm_source=twitter&utm_medium=social&ref=1';
		const normalized = normalizeUrl(url);
		expect(normalized).not.toContain('utm_source');
		expect(normalized).not.toContain('utm_medium');
		expect(normalized).toContain('ref=1');
	});

	it('removes cache-busting parameters', () => {
		const url = 'https://example.com/page?cachebust=123&noCache=true&content=real';
		const normalized = normalizeUrl(url);
		expect(normalized).not.toContain('cachebust');
		expect(normalized).not.toContain('noCache');
		expect(normalized).toContain('content=real');
	});

	it('returns original for invalid URLs', () => {
		expect(normalizeUrl('not-a-url')).toBe('not-a-url');
	});

	it('preserves clean URLs as-is', () => {
		const url = 'https://example.com/article?page=2';
		expect(normalizeUrl(url)).toBe(url);
	});
});

describe('isSocialMediaUrl', () => {
	it('detects social media domains', () => {
		expect(isSocialMediaUrl('https://twitter.com/user')).toBe(true);
		expect(isSocialMediaUrl('https://x.com/user')).toBe(true);
		expect(isSocialMediaUrl('https://instagram.com/post')).toBe(true);
		expect(isSocialMediaUrl('https://tiktok.com/@user')).toBe(true);
		expect(isSocialMediaUrl('https://facebook.com/page')).toBe(true);
		expect(isSocialMediaUrl('https://threads.net/user')).toBe(true);
	});

	it('returns false for non-social URLs', () => {
		expect(isSocialMediaUrl('https://example.com')).toBe(false);
		expect(isSocialMediaUrl('https://blog.openai.com')).toBe(false);
	});

	it('returns false for invalid URLs', () => {
		expect(isSocialMediaUrl('not-a-url')).toBe(false);
	});
});

describe('extractTitleFromHtml', () => {
	it('extracts from <title> tag', () => {
		expect(extractTitleFromHtml('<html><head><title>Hello World</title></head></html>')).toBe('Hello World');
	});

	it('falls back to <h1>', () => {
		expect(extractTitleFromHtml('<html><body><h1>Main Heading</h1></body></html>')).toBe('Main Heading');
	});

	it('returns null for empty HTML', () => {
		expect(extractTitleFromHtml('<html><body></body></html>')).toBeNull();
	});

	it('returns null for non-HTML', () => {
		expect(extractTitleFromHtml('')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// infra/embedding.ts — Text Preparation & Vector Normalization
// ─────────────────────────────────────────────────────────────

describe('prepareArticleTextForEmbedding', () => {
	it('combines title, summary, tags, and keywords', () => {
		const text = prepareArticleTextForEmbedding({
			title: 'Test Article',
			title_cn: '測試文章',
			summary: 'A summary',
			summary_cn: '摘要',
			tags: ['AI', 'Tech'],
			keywords: ['machine', 'learning'],
		});
		expect(text).toContain('Test Article');
		expect(text).toContain('測試文章');
		expect(text).toContain('A summary');
		expect(text).toContain('AI Tech');
		expect(text).toContain('machine learning');
	});

	it('handles missing optional fields', () => {
		const text = prepareArticleTextForEmbedding({ title: 'Only Title' });
		expect(text).toBe('Only Title');
	});

	it('truncates to max length', () => {
		const longTitle = 'A'.repeat(10000);
		const text = prepareArticleTextForEmbedding({ title: longTitle });
		expect(text.length).toBeLessThanOrEqual(8000);
	});
});

describe('normalizeVector', () => {
	it('normalizes a vector to unit length', () => {
		const normalized = normalizeVector([3, 4]);
		const magnitude = Math.sqrt(normalized.reduce((sum, v) => sum + v * v, 0));
		expect(magnitude).toBeCloseTo(1.0, 5);
		expect(normalized[0]).toBeCloseTo(0.6, 5);
		expect(normalized[1]).toBeCloseTo(0.8, 5);
	});

	it('returns zero vector as-is', () => {
		const normalized = normalizeVector([0, 0, 0]);
		expect(normalized).toEqual([0, 0, 0]);
	});

	it('normalizes single-element vector', () => {
		const normalized = normalizeVector([5]);
		expect(normalized).toEqual([1]);
	});
});

// ─────────────────────────────────────────────────────────────
// infra/ai.ts — JSON Extraction
// ─────────────────────────────────────────────────────────────

describe('extractJson', () => {
	it('extracts JSON from surrounding text', () => {
		const text = 'Here is the result: {"key": "value"} end.';
		expect(extractJson(text)).toEqual({ key: 'value' });
	});

	it('extracts JSON with nested objects', () => {
		const text = '```json\n{"a": {"b": 1}, "c": [1,2]}\n```';
		expect(extractJson(text)).toEqual({ a: { b: 1 }, c: [1, 2] });
	});

	it('returns null when no JSON present', () => {
		expect(extractJson('no json here')).toBeNull();
	});

	it('returns null for invalid JSON', () => {
		expect(extractJson('{invalid json}')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────
// domain/processors.ts — isEmpty & getProcessor
// ─────────────────────────────────────────────────────────────

describe('isEmpty', () => {
	it('returns true for null/undefined/empty', () => {
		expect(isEmpty(null)).toBe(true);
		expect(isEmpty(undefined)).toBe(true);
		expect(isEmpty('')).toBe(true);
		expect(isEmpty('   ')).toBe(true);
	});

	it('returns false for non-empty strings', () => {
		expect(isEmpty('hello')).toBe(false);
		expect(isEmpty(' x ')).toBe(false);
	});
});

describe('getProcessor', () => {
	it('returns twitter processor for twitter source', () => {
		const proc = getProcessor('twitter');
		expect(proc.sourceType).toBe('twitter');
	});

	it('returns hackernews processor for hackernews source', () => {
		const proc = getProcessor('hackernews');
		expect(proc.sourceType).toBe('hackernews');
	});

	it('returns default processor for unknown source', () => {
		const proc = getProcessor('unknown');
		expect(proc.sourceType).toBe('default');
	});

	it('returns default processor for undefined', () => {
		const proc = getProcessor(undefined);
		expect(proc.sourceType).toBe('default');
	});
});

// ═════════════════════════════════════════════════════════════
// HTTP Integration Tests
// ═════════════════════════════════════════════════════════════

describe('core worker HTTP endpoints', () => {
	it('returns health status', async () => {
		const request = new IncomingRequest('http://example.com/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: 'ok', worker: 'newsence-core' });
	});

	it('GET /status returns landing page (endpoint removed)', async () => {
		const response = await SELF.fetch('https://example.com/status');
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Newsence Core Worker');
	});

	it('falls back to default landing page', async () => {
		const response = await SELF.fetch('https://example.com/');
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Newsence Core Worker');
	});

	// ── POST /submit validation ──────────────────────────────

	it('POST /submit with invalid JSON returns 400', async () => {
		const response = await SELF.fetch('https://example.com/submit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not-json',
		});
		expect(response.status).toBe(400);
		const body: any = await response.json();
		expect(body.error).toContain('Invalid JSON');
	});

	it('POST /submit missing url returns 400', async () => {
		const response = await SELF.fetch('https://example.com/submit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ source: 'test' }),
		});
		expect(response.status).toBe(400);
		const body: any = await response.json();
		expect(body.error).toContain('url');
	});

	// ── POST /scrape removed ──────────────────────────────────

	it('POST /scrape returns landing page (endpoint removed)', async () => {
		const response = await SELF.fetch('https://example.com/scrape', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com' }),
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Newsence Core Worker');
	});

	// ── GET /trigger falls through to landing page ───────────

	it('GET /trigger returns landing page (wrong method)', async () => {
		const response = await SELF.fetch('https://example.com/trigger');
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Newsence Core Worker');
	});

	// ── GET /api/youtube/metadata removed ────────────────────

	it('GET /api/youtube/metadata returns landing page (endpoint removed)', async () => {
		const response = await SELF.fetch('https://example.com/api/youtube/metadata');
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Newsence Core Worker');
	});

	// ── Unknown routes ───────────────────────────────────────

	it('GET /unknown returns landing page', async () => {
		const response = await SELF.fetch('https://example.com/unknown');
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Newsence Core Worker');
	});
});
