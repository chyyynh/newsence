import { describe, expect, it } from 'vitest';
import { extractReadableArticleHtml, preferReadableArticleText } from '../src/ingest/html-content';

describe('html content extraction', () => {
	it('extracts the article body before falling back to whole-page markdown', async () => {
		const html = `
			<html>
				<head><title>Wrong shell title</title></head>
				<body>
					<nav>Home Pricing Login</nav>
					<main>
						<div class="entry-content">
							<p>${'First real paragraph about the platform change and why it matters to readers. '.repeat(4)}</p>
							<div class="ad-unit">Buy unrelated things</div>
							<p>${'Second real paragraph with enough context to be useful for downstream summarization. '.repeat(4)}</p>
							<script>window.noise = true</script>
						</div>
						<aside>Related posts should not be included.</aside>
					</main>
					<footer>Footer links</footer>
				</body>
			</html>
		`;

		const article = await extractReadableArticleHtml(html);

		expect(article?.selector).toBe('.entry-content');
		expect(article?.text).toContain('First real paragraph');
		expect(article?.text).toContain('Second real paragraph');
		expect(article?.text).not.toContain('Buy unrelated things');
		expect(article?.text).not.toContain('Related posts');
		expect(article?.html).not.toContain('<script>');
	});

	it('uses readable text when markdown conversion collapses to a short meta summary', () => {
		const readable = {
			html: '<article><p>Full paragraph one.</p><p>Full paragraph two.</p></article>',
			text: `${'Full article body. '.repeat(40)}`,
			selector: 'article',
		};

		expect(preferReadableArticleText('Short summary.', readable)).toBe(readable.text.trim());
	});
});
