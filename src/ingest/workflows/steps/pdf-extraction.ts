import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';
import { createDbClient, USER_FILES_TABLE } from '@shared/db/articles';
import { logInfo } from '@shared/log';
import type { Article, Env } from '@shared/types';

// Digital PDFs with a real text layer yield plenty of characters; scanned /
// image-only PDFs come back near-empty (LiteParse base does not OCR). We flag
// those `needs_ocr` rather than failing, so the workflow still finishes.
const MIN_CHARS = 40;
const MIN_CHARS_PER_PAGE = 20;

export type ExtractionStatus = 'ok' | 'needs_ocr' | 'failed';

export interface PdfExtractionResult {
	text: string;
	status: ExtractionStatus;
}

// Pure parse output (no DB) — shared by the workflow step and the /parse endpoint.
export interface ParsedPdf {
	text: string;
	status: Exclude<ExtractionStatus, 'failed'>;
	pages: number;
	chars: number;
}

interface LiteParseResult {
	text?: string;
	pages?: unknown[];
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

function classifyExtraction(chars: number, pages: number): 'ok' | 'needs_ocr' {
	const sparse = chars < MIN_CHARS || chars / Math.max(pages, 1) < MIN_CHARS_PER_PAGE;
	return sparse ? 'needs_ocr' : 'ok';
}

// Merge an `extraction` record into the user_files.metadata jsonb (preserving
// sibling keys), optionally writing extracted_text in the same statement. The
// single owner of extraction-state writes — used by both the success and the
// hard-failure paths.
async function recordExtraction(
	env: Env,
	articleId: string,
	status: ExtractionStatus,
	text: string | null,
	extra?: Record<string, number>,
): Promise<void> {
	const meta = JSON.stringify({ extraction: { status, parser: 'liteparse', ...extra } });
	const db = await createDbClient(env);
	try {
		const merge = `metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb`;
		if (text === null) {
			await db.query(`UPDATE ${USER_FILES_TABLE} SET ${merge} WHERE id = $2`, [meta, articleId]);
		} else {
			await db.query(`UPDATE ${USER_FILES_TABLE} SET extracted_text = $2, ${merge} WHERE id = $3`, [meta, text, articleId]);
		}
	} finally {
		await db.end();
	}
}

export function isExtractablePdf(article: Article): boolean {
	const originType = article.origin_type;
	return (originType === 'upload' || originType === 'saved_url') && article.file_type === 'application/pdf' && !!article.storage_key;
}

// Pure extraction — no R2, no DB. Runs LiteParse on raw PDF bytes and classifies
// the result. Shared by extractAndPersistPdf (workflow) and the /parse endpoint.
export function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
	ensureWasm();
	const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'text' });
	return parser.parse(bytes).then((raw: LiteParseResult) => {
		const text = raw.text ?? '';
		const pages = raw.pages?.length ?? 0;
		const chars = text.trim().length;
		return { text, pages, chars, status: classifyExtraction(chars, pages) };
	});
}

export async function extractAndPersistPdf(env: Env, articleId: string, storageKey: string): Promise<PdfExtractionResult> {
	const obj = await env.R2.get(storageKey);
	if (!obj) throw new Error(`R2 object missing: ${storageKey}`);

	const { text, status, chars, pages } = await parsePdf(new Uint8Array(await obj.arrayBuffer()));
	await recordExtraction(env, articleId, status, text, { chars, pages });
	logInfo('WORKFLOW', 'PDF extracted', { article_id: articleId, status, chars, pages });
	return { text, status };
}

// Hard-failure path: extraction threw (bad bytes, R2 miss). Flag the row so it's
// not silently empty, leaving extracted_text untouched.
export function markExtractionFailed(env: Env, articleId: string): Promise<void> {
	return recordExtraction(env, articleId, 'failed', null);
}
