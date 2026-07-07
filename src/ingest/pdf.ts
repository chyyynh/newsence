import { PDF_MIME } from '@core-shared/mime';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';

type PdfTextStatus = 'ok' | 'needs_ocr';

interface ParsedPdf {
	text: string;
	status: PdfTextStatus;
	pages: number;
	chars: number;
}

export interface PdfTextTempResult {
	status: PdfTextStatus | 'failed';
	chars: number;
	pages: number;
	textStorageKey?: string;
}

type PdfTextExtractionRequest = { articleId: string; storageKey: string; tempId: string };

const MIN_PDF_CHARS = 40;
const MIN_PDF_CHARS_PER_PAGE = 20;
const WORKFLOW_PDF_TEXT_TEMP_PREFIX = 'tmp/workflow/pdf-text/';
const WORKFLOW_PDF_TEXT_CONTENT_TYPE = 'text/markdown; charset=utf-8';

let pdfParserReady = false;

export async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
	if (!pdfParserReady) {
		initSync({ module: wasmModule });
		pdfParserReady = true;
	}
	const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'markdown', imageMode: 'off' });
	const raw = (await parser.parse(bytes)) as { text?: string; pages?: unknown[] };
	const text = (raw.text ?? '').trim();
	const pages = raw.pages?.length ?? 0;
	const chars = text.length;
	const status = chars < MIN_PDF_CHARS || chars / Math.max(pages, 1) < MIN_PDF_CHARS_PER_PAGE ? 'needs_ocr' : 'ok';
	return { text, pages, chars, status };
}

export function preparePdfTextExtraction(input: {
	articleId: string;
	hasContent?: boolean;
	storageKey?: string | null;
	originType?: string | null;
	fileType?: string | null;
	tempId: string;
}): PdfTextExtractionRequest | null {
	if (
		input.hasContent ||
		!input.storageKey ||
		!(input.originType === 'upload' || input.originType === 'saved_url') ||
		input.fileType !== PDF_MIME
	) {
		return null;
	}
	return { articleId: input.articleId, storageKey: input.storageKey, tempId: input.tempId };
}

export async function extractPdfTextToTemp(env: Env, input: PdfTextExtractionRequest): Promise<PdfTextTempResult> {
	const obj = await env.R2.get(input.storageKey);
	if (!obj) throw new Error(`PDF source object missing: ${input.storageKey}`);
	const { text, status, chars, pages } = await parsePdf(new Uint8Array(await obj.arrayBuffer()));
	const textStorageKey = `${WORKFLOW_PDF_TEXT_TEMP_PREFIX}${input.articleId}/${input.tempId}.md`;
	await env.R2.put(textStorageKey, text, { httpMetadata: { contentType: WORKFLOW_PDF_TEXT_CONTENT_TYPE } });
	return { status, chars, pages, textStorageKey };
}
