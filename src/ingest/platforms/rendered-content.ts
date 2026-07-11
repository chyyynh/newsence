import type { NormalizedContent } from '@core-shared/types';
import { readTextWithLimit } from '@core-shared/web';

const RENDERED_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
const MIN_RENDERED_CONTENT_LENGTH = 200;

export type RenderedWebContent = NormalizedContent<'web'> & {
	ogImage: {
		ogImageUrl: string | null;
		ogImageWidth: number | null;
		ogImageHeight: number | null;
	};
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function validatedContent(value: unknown, provider: string): string {
	const content = typeof value === 'string' && value.trim() ? value.trim() : null;
	if (!content || content.length < MIN_RENDERED_CONTENT_LENGTH) {
		throw new Error(`${provider} returned no usable content`);
	}
	return content;
}

async function renderMarkdownWithBrowserRun(url: string, env: CoreEnv): Promise<string> {
	const response = await env.BROWSER.quickAction('markdown', {
		url,
		gotoOptions: { waitUntil: 'networkidle2', timeout: 30_000 },
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Browser Run returned HTTP ${response.status}`);
	}

	const payload = JSON.parse(await readTextWithLimit(response, RENDERED_CONTENT_MAX_BYTES)) as unknown;
	const record = asRecord(payload);
	return validatedContent(record?.result, 'Browser Run');
}

function fallbackContent(markdown: string, title: string | null): RenderedWebContent {
	return {
		type: 'web',
		title,
		markdown,
		metadata: {
			author: null,
			language: null,
			publishedDate: null,
			siteName: null,
			description: null,
		},
		platformMetadata: { fetchedAt: new Date().toISOString(), data: null },
		ogImage: {
			ogImageUrl: null,
			ogImageWidth: null,
			ogImageHeight: null,
		},
	};
}

export async function scrapeUrlWithRenderedContent(url: string, env: CoreEnv): Promise<RenderedWebContent> {
	const markdown = await renderMarkdownWithBrowserRun(url, env);
	return fallbackContent(markdown, markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || null);
}
