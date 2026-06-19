import { isRasterImage, MAGIC_SNIFF_BYTES, PDF_MIME, sniffMediaType } from '@shared/mime';
import type { Env } from '@shared/types';
import type { ScrapedContent } from '@shared/web';
import { scrapeUrl } from './platforms/registry';
import { type ParsedPdf, parsePdf } from './workflows/steps/pdf-extraction';

// Shared extraction core: one input → one normalized shape. Wraps the existing
// engines — `scrapeUrl` (HTML / PDF / image dispatch) and `parsePdf` (LiteParse)
// — so the sync `/scrape` endpoint, the async ScrapeWorkflow, and any future
// caller all produce identical output instead of diverging per code path.

export type ExtractInput =
	| { kind: 'url'; url: string }
	| { kind: 'bytes'; bytes: Uint8Array; contentType?: string }
	| { kind: 'r2'; key: string };

export interface NormalizedContent {
	/** null for raw-bytes / R2 input (no originating URL). */
	sourceUrl: string | null;
	contentType: string;
	title: string | null;
	/** HTML → turndown markdown; PDF → reflowed text (real markdown tracked in #166). */
	markdown: string;
	/** Plain text; PDF → reflowed text; HTML → markdown-stripped. */
	text: string;
	metadata: {
		author: string | null;
		publishedDate: string | null;
		siteName: string | null;
		description: string | null;
		ogImageUrl: string | null;
		pages?: number;
		chars?: number;
	};
	status: 'ok' | 'needs_ocr' | 'failed';
}

const EMPTY_METADATA: NormalizedContent['metadata'] = {
	author: null,
	publishedDate: null,
	siteName: null,
	description: null,
	ogImageUrl: null,
};

// Lossy markdown → plain text. Cheap and good enough for the `text` field; we
// don't need a real renderer, just the words without the syntax.
function stripMarkdown(md: string): string {
	return md
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → label
		.replace(/^#{1,6}\s+/gm, '') // headings
		.replace(/(\*\*|__|\*|_|`)/g, '') // emphasis / inline code
		.replace(/^\s*[-*+]\s+/gm, '') // bullet markers
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function normalizeHtml(scraped: ScrapedContent, sourceUrl: string | null): NormalizedContent {
	const markdown = scraped.content ?? '';
	return {
		sourceUrl,
		contentType: 'text/html',
		title: scraped.title || null,
		markdown,
		text: stripMarkdown(markdown),
		metadata: {
			author: scraped.author ?? null,
			publishedDate: scraped.publishedDate ?? null,
			siteName: scraped.siteName ?? null,
			description: scraped.summary ?? null,
			ogImageUrl: scraped.ogImageUrl ?? null,
		},
		status: markdown.trim().length > 0 ? 'ok' : 'failed',
	};
}

function normalizePdf(parsed: ParsedPdf, sourceUrl: string | null): NormalizedContent {
	return {
		sourceUrl,
		contentType: PDF_MIME,
		title: null,
		markdown: parsed.text,
		text: parsed.text,
		metadata: { ...EMPTY_METADATA, pages: parsed.pages, chars: parsed.chars },
		status: parsed.status,
	};
}

// Empty result for inputs with no extractable text layer: images (needs_ocr,
// handled in #166) or unrecognized bytes (failed). No throw.
function emptyResult(contentType: string, sourceUrl: string | null, status: 'needs_ocr' | 'failed'): NormalizedContent {
	return { sourceUrl, contentType, title: null, markdown: '', text: '', metadata: { ...EMPTY_METADATA }, status };
}

async function extractFromBytes(bytes: Uint8Array, declaredType?: string): Promise<NormalizedContent> {
	const sniffed = sniffMediaType(bytes.subarray(0, MAGIC_SNIFF_BYTES));
	const type = sniffed ?? declaredType ?? 'application/octet-stream';
	if (type === PDF_MIME) return normalizePdf(await parsePdf(bytes), null);
	return emptyResult(type, null, isRasterImage(type) ? 'needs_ocr' : 'failed');
}

async function extractFromUrl(env: Env, url: string): Promise<NormalizedContent> {
	const result = await scrapeUrl(url, { youtubeApiKey: env.YOUTUBE_API_KEY, kaitoApiKey: env.KAITO_API_KEY });
	if (result.kind === 'page') return normalizeHtml(result.scraped, url);

	// blob: stream the body into the appropriate extractor, then release the timer.
	try {
		if (result.contentType === PDF_MIME) {
			const bytes = new Uint8Array(await new Response(result.body).arrayBuffer());
			return normalizePdf(await parsePdf(bytes), result.sourceUrl);
		}
		await result.body.cancel();
		return emptyResult(result.contentType, result.sourceUrl, 'needs_ocr');
	} finally {
		result.dispose();
	}
}

export async function extractSource(env: Env, input: ExtractInput): Promise<NormalizedContent> {
	switch (input.kind) {
		case 'url':
			return extractFromUrl(env, input.url);
		case 'bytes':
			return extractFromBytes(input.bytes, input.contentType);
		case 'r2': {
			const obj = await env.R2.get(input.key);
			if (!obj) throw new Error(`R2 object missing: ${input.key}`);
			return extractFromBytes(new Uint8Array(await obj.arrayBuffer()), obj.httpMetadata?.contentType);
		}
	}
}
