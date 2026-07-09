import { describe, expect, it } from 'vitest';
import { generateArticleAnalysis } from '../src/ingest/domain/ai-utils';
import type { Article } from '../src/shared/types';

function baseArticle(content: string): Article {
	return {
		id: 'test-article',
		title: 'Test article',
		title_cn: null,
		summary: 'A test article.',
		summary_cn: null,
		content,
		content_cn: null,
		url: 'https://example.com/article',
		source: 'Example',
		published_date: '2026-07-09T00:00:00.000Z',
		tags: [],
		keywords: [],
		source_type: 'youtube',
		platform_metadata: undefined,
	};
}

function fakeEnv(calls: string[]): CoreEnv {
	return {
		AI: {
			run: async (_model: string, inputs: Record<string, unknown>, options?: { gateway?: { metadata?: { task?: string } } }) => {
				const task = options?.gateway?.metadata?.task ?? 'unknown';
				calls.push(task);

				if (task === 'article-translation') {
					return {
						choices: [
							{
								message: {
									content: JSON.stringify({
										title_cn: '測試文章',
										summary_en: 'A test article.',
										summary_cn: '一篇測試文章。',
									}),
								},
							},
						],
					};
				}

				if (task === 'article-classification') {
					return {
						choices: [
							{
								message: {
									content: JSON.stringify({
										tags: ['Tech'],
										keywords: ['testing'],
										entities: [],
										category: 'Tech',
									}),
								},
							},
						],
					};
				}

				const prompt = (inputs.contents as Array<{ parts: Array<{ text: string }> }>)[0]?.parts[0]?.text ?? '';
				return { candidates: [{ content: { parts: [{ text: '譯'.repeat(Math.ceil(prompt.length * 0.5)) }] } }] };
			},
		},
		AI_GATEWAY_NAME: 'default',
	} as unknown as CoreEnv;
}

describe('generateArticleAnalysis content translation', () => {
	it('translates long article content in chunks', async () => {
		const calls: string[] = [];
		const paragraph = 'This is a long English paragraph that should be translated, not summarized. '.repeat(35);
		const content = Array.from({ length: 8 }, (_, index) => `## Section ${index + 1}\n\n${paragraph}`).join('\n\n');

		const result = await generateArticleAnalysis(baseArticle(content), fakeEnv(calls));

		expect(calls.filter((call) => call === 'article-content-translation').length).toBeGreaterThan(1);
		expect(result.content_cn?.length ?? 0).toBeGreaterThan(content.length * 0.2);
	});

	it('normalizes Chinese source content into content_cn instead of skipping translation', async () => {
		const calls: string[] = [];
		const content = '这是简体中文内容，仍然应该写入繁体中文 content_cn。'.repeat(20);

		const result = await generateArticleAnalysis(baseArticle(content), fakeEnv(calls));

		expect(calls).toContain('article-content-translation');
		expect(result.content_cn).toEqual(expect.any(String));
	});
});
