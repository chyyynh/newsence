import type { WorkflowStep } from 'cloudflare:workers';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';

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
	text?: string;
}

const MIN_PDF_CHARS = 40;
const MIN_PDF_CHARS_PER_PAGE = 20;

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

async function extractPdfText(env: CoreEnv, input: { sourceStorageKey: string }): Promise<ReadableStream<Uint8Array>> {
	const obj = await env.R2.get(input.sourceStorageKey);
	if (!obj) throw new Error(`PDF source object missing: ${input.sourceStorageKey}`);
	const { text, status, chars, pages } = await parsePdf(new Uint8Array(await obj.arrayBuffer()));
	return new Response(JSON.stringify({ status, chars, pages, text } satisfies PdfTextArtifact)).body!;
}

export async function stagePdfTextExtraction(
	env: CoreEnv,
	step: WorkflowStep,
	input: { articleId: string; sourceStorageKey: string },
): Promise<PdfTextArtifact> {
	try {
		const artifact = await step.do(
			'extract-pdf-text',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			() => extractPdfText(env, input),
		);
		return (await new Response(artifact).json()) as PdfTextArtifact;
	} catch (error) {
		console.warn({ tag: 'WORKFLOW', msg: 'PDF extraction failed', article_id: input.articleId, error: String(error) });
		return { status: 'failed', chars: 0, pages: 0 };
	}
}
