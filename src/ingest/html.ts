import { canonicalizeOptionalResourceLang } from '@core-shared/resource-types';
import { extractFromHtml } from '@extractus/article-extractor';
import { decode } from 'html-entities';

const MIN_ARTICLE_TEXT_CHARS = 180;

export type ExtractedHtmlArticle = {
	html: string;
	title: string | null;
	author: string | null;
	language: string | null;
	publishedDate: string | null;
	siteName: string | null;
	description: string | null;
};

function optionalText(value: string | undefined): string | null {
	return value?.trim() || null;
}

async function extractSupplementalMetadata(html: string): Promise<{ language: string | null; siteName: string | null }> {
	let language: string | null = null;
	let siteName: string | null = null;
	await new HTMLRewriter()
		.on('html[lang]', {
			element(element) {
				language ??= canonicalizeOptionalResourceLang(element.getAttribute('lang'));
			},
		})
		.on('meta[property="og:locale"]', {
			element(element) {
				language ??= canonicalizeOptionalResourceLang(element.getAttribute('content'));
			},
		})
		.on('meta[property="og:site_name"]', {
			element(element) {
				const content = element.getAttribute('content')?.trim();
				if (!siteName && content) siteName = decode(content).trim() || null;
			},
		})
		.transform(new Response(html))
		.arrayBuffer();
	return { language, siteName };
}

export async function extractHtmlArticle(html: string, url: string): Promise<ExtractedHtmlArticle | null> {
	const [article, supplementalMetadata] = await Promise.all([
		extractFromHtml(html, url, { contentLengthThreshold: MIN_ARTICLE_TEXT_CHARS }),
		extractSupplementalMetadata(html),
	]);
	if (!article?.content?.trim()) return null;
	const articleHtml = article.content.trim();

	return {
		html: articleHtml,
		title: optionalText(article.title),
		author: optionalText(article.author),
		language: supplementalMetadata.language,
		publishedDate: optionalText(article.published),
		siteName: supplementalMetadata.siteName ?? optionalText(article.source),
		description: optionalText(article.description),
	};
}
