import type { WorkflowStep } from 'cloudflare:workers';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';

const PDF_MIME = 'application/pdf';

type PdfTextStatus = 'ok' | 'needs_ocr';

interface ParsedPdf {
	text: string;
	status: PdfTextStatus;
	pages: number;
	chars: number;
}

interface PdfTextArtifact {
	status: PdfTextStatus | 'failed';
	chars: number;
	pages: number;
	extractedTextKey?: string;
}

const MIN_PDF_CHARS = 40;
const MIN_PDF_CHARS_PER_PAGE = 20;
const WORKFLOW_PDF_TEXT_SCRATCH_PREFIX = 'workflow/scratch/pdf-text/';
const PDF_TEXT_MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';

let pdfParserReady = false;

async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
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

async function writeExtractedPdfText(
	env: Env,
	input: { articleId: string; sourceStorageKey: string; workflowRunId: string },
): Promise<PdfTextArtifact> {
	const obj = await env.R2.get(input.sourceStorageKey);
	if (!obj) throw new Error(`PDF source object missing: ${input.sourceStorageKey}`);
	const { text, status, chars, pages } = await parsePdf(new Uint8Array(await obj.arrayBuffer()));
	const extractedTextKey = `${WORKFLOW_PDF_TEXT_SCRATCH_PREFIX}${input.articleId}/${input.workflowRunId}.md`;
	await env.R2.put(extractedTextKey, text, { httpMetadata: { contentType: PDF_TEXT_MARKDOWN_CONTENT_TYPE } });
	return { status, chars, pages, extractedTextKey };
}

export async function stagePdfTextExtraction(
	env: Env,
	step: WorkflowStep,
	input: {
		articleId: string | null;
		hasContent?: boolean;
		sourceStorageKey?: string | null;
		fileType?: string | null;
		workflowRunId: string;
	},
): Promise<PdfTextArtifact | null> {
	if (input.hasContent || !input.articleId || !input.sourceStorageKey || input.fileType !== PDF_MIME) {
		return null;
	}
	const request = { articleId: input.articleId, sourceStorageKey: input.sourceStorageKey, workflowRunId: input.workflowRunId };

	try {
		return await step.do(
			'extract-pdf-text',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			() => writeExtractedPdfText(env, request),
		);
	} catch (error) {
		console.warn({ tag: 'WORKFLOW', msg: 'PDF extraction failed', article_id: request.articleId, error: String(error) });
		return { status: 'failed', chars: 0, pages: 0 };
	}
}

export async function readExtractedPdfText(env: Env, result: PdfTextArtifact | null): Promise<string | null> {
	if (!result?.extractedTextKey) return null;
	const obj = await env.R2.get(result.extractedTextKey);
	if (!obj) throw new Error(`PDF extracted text object missing: ${result.extractedTextKey}`);
	return obj.text();
}

export function pdfTextExtractionMetadata(result: PdfTextArtifact | null): Record<string, unknown> | undefined {
	if (!result) return undefined;
	const extraction = { status: result.status, parser: 'liteparse' };
	return { extraction: result.status === 'failed' ? extraction : { ...extraction, chars: result.chars, pages: result.pages } };
}
