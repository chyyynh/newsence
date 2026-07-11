import type { WorkflowStep } from 'cloudflare:workers';
import { initSync, LiteParse } from '@llamaindex/liteparse-wasm';
import wasmModule from '@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm';

type PdfTextStatus = 'ok' | 'needs_ocr';

export interface PdfTextArtifact {
	text: string;
	status: PdfTextStatus;
	pages: number;
	chars: number;
}

const MIN_PDF_CHARS = 40;
const MIN_PDF_CHARS_PER_PAGE = 20;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

let pdfParserReady = false;

function extractedTextChars(markdown: string): number {
	const content = markdown.replace(/^```[^\n]*$/gm, '').replace(/^[-_*]{3,}$/gm, '');
	return content.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

export async function parsePdfBytes(bytes: Uint8Array): Promise<PdfTextArtifact> {
	if (!pdfParserReady) {
		initSync({ module: wasmModule });
		pdfParserReady = true;
	}
	const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'markdown', imageMode: 'off' });
	const raw = (await parser.parse(bytes)) as { text?: string; pages?: unknown[] };
	const text = (raw.text ?? '').trim();
	const pages = raw.pages?.length ?? 0;
	const chars = extractedTextChars(text);
	const status = chars < MIN_PDF_CHARS || chars / Math.max(pages, 1) < MIN_PDF_CHARS_PER_PAGE ? 'needs_ocr' : 'ok';
	return { text, pages, chars, status };
}

async function extractPdfText(env: CoreEnv, input: { sourceStorageKey: string }): Promise<ReadableStream<Uint8Array>> {
	const obj = await env.R2.get(input.sourceStorageKey);
	if (!obj) throw new Error(`PDF source object missing: ${input.sourceStorageKey}`);
	if (obj.size > MAX_PDF_BYTES) throw new Error(`PDF source object exceeded ${MAX_PDF_BYTES} bytes`);
	const { text, status, chars, pages } = await parsePdfBytes(new Uint8Array(await obj.arrayBuffer()));
	return new Response(JSON.stringify({ status, chars, pages, text } satisfies PdfTextArtifact)).body!;
}

export async function stagePdfTextExtraction(
	env: CoreEnv,
	step: WorkflowStep,
	input: { sourceStorageKey: string },
): Promise<PdfTextArtifact> {
	const artifact = await step.do(
		'extract-pdf-text',
		{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		() => extractPdfText(env, input),
	);
	return (await new Response(artifact).json()) as PdfTextArtifact;
}
