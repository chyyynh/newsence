import { describe, expect, it } from 'vitest';
import { isExtractablePdf } from '../src/app/workflows/steps/pdf-extraction';
import type { Article } from '../src/models/types';

function article(overrides: Partial<Article>): Article {
	return {
		id: 'file-1',
		title: 'PDF',
		summary: null,
		content: null,
		url: 'https://example.com/file.pdf',
		source: 'External',
		published_date: new Date().toISOString(),
		tags: [],
		keywords: [],
		...overrides,
	};
}

describe('isExtractablePdf', () => {
	it('allows uploaded PDFs and URL-sourced PDFs', () => {
		const base = { file_type: 'application/pdf', storage_key: 'users/u/uploads/file.pdf' };

		expect(isExtractablePdf(article({ ...base, origin_type: 'upload' }))).toBe(true);
		expect(isExtractablePdf(article({ ...base, origin_type: 'saved_url' }))).toBe(true);
	});

	it('rejects non-PDFs and PDFs without R2 storage', () => {
		expect(isExtractablePdf(article({ origin_type: 'saved_url', file_type: 'image/png', storage_key: 'users/u/uploads/file.png' }))).toBe(
			false,
		);
		expect(isExtractablePdf(article({ origin_type: 'saved_url', file_type: 'application/pdf', storage_key: null }))).toBe(false);
	});
});
