const READABLE_CONTENT_SELECTORS = [
	'article',
	'[itemprop="articleBody"]',
	'.entry-content',
	'.post-content',
	'.article-content',
	'.article__content',
	'.story-content',
	'.post__content',
	'.content__article-body',
	'.article-body',
	'[role="main"]',
	'main',
] as const;

const JUNK_SELECTORS = [
	'script',
	'style',
	'noscript',
	'template',
	'svg',
	'form',
	'iframe',
	'nav',
	'aside',
	'.ad-unit',
	'.advertisement',
	'.newsletter',
	'.related-posts',
] as const;

const TEXT_BLOCK_SELECTORS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'pre'] as const;
const START_MARKER = '<!--newsence-resource-content-start-->';
const END_MARKER = '<!--newsence-resource-content-end-->';
const GOOD_CONTENT_TEXT_CHARS = 400;
const MIN_CONTENT_TEXT_CHARS = 180;
const READABLE_TEXT_FALLBACK_RATIO = 1.8;

export type ReadableContentHtml = {
	html: string;
	text: string;
	selector: string;
};

function normalizeText(value: string): string {
	return decodeHtmlEntities(value)
		.replace(/\u00a0/g, ' ')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n[ \t]+/g, '\n')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

async function cleanContentHtml(html: string): Promise<string> {
	let rewriter = new HTMLRewriter();
	for (const selector of JUNK_SELECTORS) {
		rewriter = rewriter.on(selector, {
			element(element) {
				element.remove();
			},
		});
	}
	return (await rewriter.transform(new Response(html)).text()).trim();
}

async function extractFirstElementHtml(html: string, selector: string): Promise<string | null> {
	let found = false;
	const marked = await new HTMLRewriter()
		.on(selector, {
			element(element) {
				if (found) return;
				found = true;
				element.before(START_MARKER, { html: true });
				element.onEndTag((endTag) => {
					endTag.after(END_MARKER, { html: true });
				});
			},
		})
		.transform(new Response(html))
		.text();
	if (!found) return null;

	const start = marked.indexOf(START_MARKER);
	const end = marked.indexOf(END_MARKER, start + START_MARKER.length);
	if (start < 0 || end < 0) return null;
	const extracted = marked.slice(start + START_MARKER.length, end).trim();
	return extracted || null;
}

async function extractBlockText(html: string): Promise<string> {
	const chunks: string[] = [];
	let foundBlock = false;
	const handler: HTMLRewriterElementContentHandlers = {
		element(element) {
			foundBlock = true;
			element.onEndTag(() => {
				chunks.push('\n\n');
			});
		},
		text(text) {
			if (text.text) chunks.push(text.text);
		},
	};
	let rewriter = new HTMLRewriter();
	for (const selector of TEXT_BLOCK_SELECTORS) rewriter = rewriter.on(selector, handler);
	await rewriter.transform(new Response(html)).arrayBuffer();
	if (foundBlock) return normalizeText(chunks.join(''));

	const fallbackChunks: string[] = [];
	await new HTMLRewriter()
		.onDocument({
			text(text) {
				if (text.text) fallbackChunks.push(text.text);
			},
		})
		.transform(new Response(html))
		.arrayBuffer();
	return normalizeText(fallbackChunks.join(' '));
}

export async function extractReadableContentHtml(html: string): Promise<ReadableContentHtml | null> {
	let best: ReadableContentHtml | null = null;
	for (const selector of READABLE_CONTENT_SELECTORS) {
		const extracted = await extractFirstElementHtml(html, selector);
		if (!extracted) continue;

		const cleanHtml = await cleanContentHtml(extracted);
		const text = await extractBlockText(cleanHtml);
		if (text.length < MIN_CONTENT_TEXT_CHARS) continue;

		const candidate = { html: cleanHtml, text, selector };
		if (text.length >= GOOD_CONTENT_TEXT_CHARS) return candidate;
		if (!best || text.length > best.text.length) best = candidate;
	}
	return best;
}

export function preferReadableContentText(markdown: string, readable: ReadableContentHtml | null): string {
	const trimmedMarkdown = decodeHtmlEntities(markdown).trim();
	const readableText = normalizeText(readable?.text ?? '');
	if (readableText.length >= GOOD_CONTENT_TEXT_CHARS && readableText.length > trimmedMarkdown.length * READABLE_TEXT_FALLBACK_RATIO) {
		return readableText;
	}
	return trimmedMarkdown;
}
