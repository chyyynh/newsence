import { describe, expect, it } from 'vitest';
import type { ProcessorResult } from '../src/domain/processors';
import { buildEmbeddingTextForArticle, collectAllComments, mergePlatformMetadata } from '../src/domain/processors';

describe('mergePlatformMetadata', () => {
	it('returns null when both metadata and enrichments are empty', () => {
		expect(mergePlatformMetadata(null, undefined)).toBeNull();
	});

	it('preserves metadata when no enrichments are provided', () => {
		const base = {
			type: 'twitter',
			fetchedAt: '2026-02-09T00:00:00.000Z',
			data: { author: 'alice' },
		};
		expect(mergePlatformMetadata(base, undefined)).toEqual(base);
	});

	it('merges enrichments and keeps existing fields', () => {
		const base = {
			type: 'hackernews',
			fetchedAt: '2026-02-09T00:00:00.000Z',
			data: { itemId: '123' },
			enrichments: { oldKey: 'keep-me' },
		};
		const merged = mergePlatformMetadata(base, { discussionSummary: 'summary' });

		expect(merged?.type).toBe('hackernews');
		expect(merged?.data).toEqual({ itemId: '123' });
		expect(merged?.enrichments?.oldKey).toBe('keep-me');
		expect(merged?.enrichments?.discussionSummary).toBe('summary');
		expect(typeof merged?.enrichments?.processedAt).toBe('string');
	});
});

describe('buildEmbeddingTextForArticle', () => {
	it('uses updated processor fields when available', () => {
		const article = {
			title: 'Original title',
			title_cn: null,
			summary: 'Original summary',
			summary_cn: null,
			tags: ['old'],
			keywords: ['legacy'],
		};
		const result: ProcessorResult = {
			updateData: {
				title_cn: '新的標題',
				summary_cn: '新的摘要',
				tags: ['ai', 'tech'],
				keywords: ['cloudflare', 'worker'],
			},
		};

		const text = buildEmbeddingTextForArticle(article, result);
		expect(text).toContain('Original title');
		expect(text).toContain('新的標題');
		expect(text).toContain('Original summary');
		expect(text).toContain('新的摘要');
		expect(text).toContain('ai tech');
		expect(text).toContain('cloudflare worker');
	});

	it('falls back to original article fields', () => {
		const article = {
			title: 'Keep title',
			title_cn: '保留標題',
			summary: 'Keep summary',
			summary_cn: '保留摘要',
			tags: ['t1'],
			keywords: ['k1'],
		};
		const result: ProcessorResult = { updateData: {} };

		const text = buildEmbeddingTextForArticle(article, result);
		expect(text).toContain('Keep title');
		expect(text).toContain('保留標題');
		expect(text).toContain('Keep summary');
		expect(text).toContain('保留摘要');
		expect(text).toContain('t1');
		expect(text).toContain('k1');
	});
});

describe('collectAllComments', () => {
	it('flattens nested comments and strips html', () => {
		const comments = collectAllComments([
			{
				id: 1,
				author: 'alice',
				text: '<p>Hello <b>world</b> &amp; team</p>',
				children: [
					{
						id: 2,
						author: 'bob',
						text: '<i>Nested</i> reply',
						children: [],
					},
				],
			},
		] as any);

		expect(comments).toEqual([
			{ id: 1, author: 'alice', text: 'Hello world & team' },
			{ id: 2, author: 'bob', text: 'Nested reply' },
		]);
	});
});
