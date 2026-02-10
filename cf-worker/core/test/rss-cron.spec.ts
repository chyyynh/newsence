import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSupabaseClientMock = vi.fn();
const getArticlesTableMock = vi.fn(() => 'articles');
const scrapeArticleContentMock = vi.fn();
const extractOgImageMock = vi.fn();
const fetchPlatformMetadataMock = vi.fn();

vi.mock('../src/infra/db', () => ({
	getSupabaseClient: (...args: unknown[]) => getSupabaseClientMock(...args),
	getArticlesTable: (...args: unknown[]) => getArticlesTableMock(...args),
}));

vi.mock('../src/infra/web', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/infra/web')>();
	return {
		...original,
		scrapeArticleContent: (...args: unknown[]) => scrapeArticleContentMock(...args),
		extractOgImage: (...args: unknown[]) => extractOgImageMock(...args),
	};
});

vi.mock('../src/infra/platform', () => ({
	fetchPlatformMetadata: (...args: unknown[]) => fetchPlatformMetadataMock(...args),
}));

import { handleRSSCron } from '../src/app/schedule';

function createSupabaseMock(options: {
	feeds: Array<{ id: string; name: string; RSSLink: string; url: string; type: string }>;
	existingUrls?: string[];
	insertedId?: string;
}) {
	const insertRowsMock = vi.fn(async (_rows?: unknown[]) => ({
		data: options.insertedId ? [{ id: options.insertedId }] : [],
		error: null,
	}));
	const updateEqMock = vi.fn().mockResolvedValue({ error: null });
	const inMock = vi.fn().mockResolvedValue({
		data: (options.existingUrls ?? []).map((url) => ({ url })),
	});

	const supabase = {
		from: vi.fn((table: string) => ({
			select: vi.fn((columns: string) => {
				if (table === 'RssList' && columns.includes('RSSLink')) {
					return Promise.resolve({ data: options.feeds, error: null });
				}
				if (table === 'articles' && columns === 'url') {
					return { in: inMock };
				}
				return Promise.resolve({ data: [], error: null });
			}),
			insert: vi.fn((rows: unknown[]) => ({
				select: vi.fn(() => {
					return insertRowsMock(rows);
				}),
			})),
			update: vi.fn(() => ({
				eq: updateEqMock,
			})),
		})),
	};

	return { supabase, insertRowsMock, inMock, updateEqMock };
}

describe('handleRSSCron', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		scrapeArticleContentMock.mockResolvedValue('# Parsed Title\n\nBody content from crawler.');
		extractOgImageMock.mockResolvedValue('https://img.example.com/cover.jpg');
		fetchPlatformMetadataMock.mockResolvedValue({ platformMetadata: null, sourceType: 'rss' });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('ingests new RSS items and enqueues article processing', async () => {
		const feeds = [{ id: 'feed-1', name: 'Tech Feed', RSSLink: 'https://feed.example.com/rss.xml', url: '', type: 'rss' }];
		const { supabase, insertRowsMock, updateEqMock } = createSupabaseMock({
			feeds,
			existingUrls: [],
			insertedId: 'article-1',
		});

		getSupabaseClientMock.mockReturnValue(supabase);
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					`<?xml version="1.0"?><rss><channel><item><title>Hello</title><link>https://example.com/a</link><description>Desc</description><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>`,
					{ status: 200, headers: { 'content-type': 'application/rss+xml' } }
				)
			)
		);

		const sendMock = vi.fn().mockResolvedValue(undefined);
		const env = { ARTICLE_QUEUE: { send: sendMock }, ARTICLES_TABLE: 'articles' } as any;

		await handleRSSCron(env, {} as any);

		expect(insertRowsMock).toHaveBeenCalledTimes(1);
		const inserted = insertRowsMock.mock.calls[0]?.[0] as any[];
		expect(inserted[0]?.url).toBe('https://example.com/a');
		expect(inserted[0]?.source_type).toBe('rss');
		expect(sendMock).toHaveBeenCalledWith({
			type: 'article_process',
			article_id: 'article-1',
			source_type: 'rss',
		});
		expect(updateEqMock).toHaveBeenCalledWith('id', 'feed-1');
	});

	it('skips existing URLs and does not enqueue duplicates', async () => {
		const feeds = [{ id: 'feed-1', name: 'Tech Feed', RSSLink: 'https://feed.example.com/rss.xml', url: '', type: 'rss' }];
		const existing = ['https://example.com/a'];
		const { supabase, insertRowsMock } = createSupabaseMock({
			feeds,
			existingUrls: existing,
			insertedId: 'article-1',
		});

		getSupabaseClientMock.mockReturnValue(supabase);
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response(
					`<?xml version="1.0"?><rss><channel><item><title>Hello</title><link>https://example.com/a</link><description>Desc</description></item></channel></rss>`,
					{ status: 200, headers: { 'content-type': 'application/rss+xml' } }
				)
			)
		);

		const sendMock = vi.fn().mockResolvedValue(undefined);
		const env = { ARTICLE_QUEUE: { send: sendMock }, ARTICLES_TABLE: 'articles' } as any;

		await handleRSSCron(env, {} as any);

		expect(insertRowsMock).not.toHaveBeenCalled();
		expect(sendMock).not.toHaveBeenCalled();
	});

});
