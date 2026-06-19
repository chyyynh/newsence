import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import type { Env } from '@shared/types';

// Digital PDFs with a real text layer yield plenty of characters; scanned /
// image-only PDFs come back near-empty (LiteParse base does not OCR). We flag
// those `needs_ocr` rather than failing, so the workflow still finishes.
const MIN_CHARS = 40;
const MIN_CHARS_PER_PAGE = 20;
const TMP_PDF_TEXT_PREFIX = 'tmp/workflow/pdf-text/';

export type ExtractionStatus = 'ok' | 'needs_ocr' | 'failed';

export interface PdfExtractionResult {
	status: ExtractionStatus;
	chars: number;
	pages: number;
	textStorageKey?: string;
}

// Pure parse output (no DB) — shared by the workflow step and the /scrape endpoint.
export interface ParsedPdf {
	text: string;
	status: Exclude<ExtractionStatus, 'failed'>;
	pages: number;
	chars: number;
}

// LiteParse WASM is instantiated once per isolate; the `CompiledWasm` wrangler
// rule turns the import into a `WebAssembly.Module`.
let wasmReady = false;
function ensureWasm(): void {
	if (!wasmReady) {
		initSync({ module: wasmModule });
		wasmReady = true;
	}
}

// Pure extraction — no R2, no DB. Runs LiteParse on raw PDF bytes and classifies
// the result. Shared by extractAndPersistPdf (workflow) and the /scrape endpoint.
// Markdown mode renders layout (headings, multi-column reflow, tables, links) onto
// `result.text`; `result.pages` is kept only for the page count. `imageMode: 'off'`
// keeps embedded-image placeholders out — LiteParse can't extract our figures anyway.
export async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
	ensureWasm();
	const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'markdown', imageMode: 'off' });
	const raw = (await parser.parse(bytes)) as { text?: string; pages?: unknown[] };
	const text = (raw.text ?? '').trim();
	const pages = raw.pages?.length ?? 0;
	const chars = text.length;
	const status = chars < MIN_CHARS || chars / Math.max(pages, 1) < MIN_CHARS_PER_PAGE ? 'needs_ocr' : 'ok';
	return { text, pages, chars, status };
}

export async function extractPdfToTextArtifact(env: Env, articleId: string, storageKey: string): Promise<PdfExtractionResult> {
	const obj = await env.R2.get(storageKey);
	if (!obj) throw new Error(`R2 object missing: ${storageKey}`);

	const { text, status, chars, pages } = await parsePdf(new Uint8Array(await obj.arrayBuffer()));
	const textStorageKey = `${TMP_PDF_TEXT_PREFIX}${articleId}/${crypto.randomUUID()}.md`;
	await env.R2.put(textStorageKey, text, {
		httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
	});
	console.info({ tag: 'WORKFLOW', msg: 'PDF extracted', article_id: articleId, status, chars, pages });
	return { status, chars, pages, textStorageKey };
}

export async function readPdfTextArtifact(env: Env, textStorageKey: string): Promise<string> {
	if (!textStorageKey.startsWith(TMP_PDF_TEXT_PREFIX)) throw new Error(`Invalid PDF text artifact key: ${textStorageKey}`);
	const obj = await env.R2.get(textStorageKey);
	if (!obj) throw new Error(`PDF text artifact missing: ${textStorageKey}`);
	return obj.text();
}

export async function deletePdfTextArtifact(env: Env, textStorageKey: string): Promise<void> {
	if (!textStorageKey.startsWith(TMP_PDF_TEXT_PREFIX)) throw new Error(`Invalid PDF text artifact key: ${textStorageKey}`);
	await env.R2.delete(textStorageKey);
}
