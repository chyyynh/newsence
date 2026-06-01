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

// Pure parse output (no DB) — shared by the workflow step and the /scrape endpoint.
export interface ParsedPdf {
	text: string;
	status: Exclude<ExtractionStatus, 'failed'>;
	pages: number;
	chars: number;
}

// LiteParse emits text fragments with bounding boxes, faithful to the PDF's
// visual line breaks — so a wrapped paragraph arrives as N indented lines. We
// reflow them back into paragraphs from the geometry below.
interface TextItem {
	text?: string;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}
interface LiteParsePage {
	width?: number;
	textItems?: TextItem[];
}
interface LiteParseResult {
	pages?: LiteParsePage[];
}

interface Line {
	text: string;
	y: number;
	x: number;
	h: number;
}

function median(nums: number[], fallback: number): number {
	if (!nums.length) return fallback;
	const sorted = [...nums].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

// Merge fragments sharing a y-band into one visual line (left-to-right),
// collapsing the justified-text padding into single spaces.
function pageLines(items: TextItem[]): Line[] {
	const bands = new Map<number, TextItem[]>();
	for (const it of items) {
		if (!it.text?.trim()) continue;
		const key = Math.round((it.y ?? 0) / 3); // ~3px tolerance
		const band = bands.get(key);
		if (band) band.push(it);
		else bands.set(key, [it]);
	}
	return [...bands.values()]
		.map((frs) => {
			frs.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
			return {
				text: frs
					.map((f) => f.text)
					.join(' ')
					.replace(/\s+/g, ' ')
					.trim(),
				y: Math.min(...frs.map((f) => f.y ?? 0)),
				x: Math.min(...frs.map((f) => f.x ?? 0)),
				h: Math.max(...frs.map((f) => f.height ?? 0)),
			};
		})
		.filter((l) => l.text)
		.sort((a, b) => a.y - b.y);
}

// Join wrapped lines into paragraphs: break on a larger-than-normal vertical
// gap, a first-line indent, or a taller line (heading). De-hyphenate splits.
function reflowLines(lines: Line[]): string[] {
	if (!lines.length) return [];
	const gaps = lines
		.slice(1)
		.map((l, i) => l.y - lines[i].y)
		.filter((g) => g > 0);
	const medGap = median(gaps, 14);
	const medH = median(
		lines.map((l) => l.h),
		13,
	);
	// Body left margin = the most common left-x (mode), not the min — a single
	// outlier line (e.g. a running header indented differently) must not make
	// every body line look "indented" and break every line into its own paragraph.
	const xFreq = new Map<number, number>();
	for (const l of lines) {
		const k = Math.round(l.x);
		xFreq.set(k, (xFreq.get(k) ?? 0) + 1);
	}
	let bodyX = lines[0].x;
	let bodyXCount = 0;
	for (const [x, n] of xFreq) {
		if (n > bodyXCount) {
			bodyXCount = n;
			bodyX = x;
		}
	}
	const paras: string[] = [];
	let cur = '';
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (i === 0) {
			cur = l.text;
			continue;
		}
		const isHeading = l.h > medH * 1.3;
		const gapBreak = l.y - lines[i - 1].y > medGap * 1.6;
		const indent = l.x > bodyX + 6;
		if (isHeading || gapBreak || indent) {
			paras.push(cur);
			cur = l.text;
		} else {
			cur = /[-‐]$/.test(cur) ? cur.replace(/[-‐]$/, '') + l.text : `${cur} ${l.text}`;
		}
	}
	if (cur) paras.push(cur);
	return paras;
}

// Detect a vertical gutter (2-column layout) and split fragments into columns,
// left-to-right. Conservative: a gutter is accepted only when almost no fragment
// crosses it and both sides carry real text — single-column body lines span the
// centre, so they never trigger a false split. Returns one group when single-col.
function splitColumns(items: TextItem[], pageWidth: number): TextItem[][] {
	if (items.length < 8 || pageWidth <= 0) return [items];
	const center = (it: TextItem) => (it.x ?? 0) + (it.width ?? 0) / 2;
	let best: { g: number; crossing: number } | null = null;
	for (let g = pageWidth * 0.35; g <= pageWidth * 0.65; g += pageWidth * 0.02) {
		let crossing = 0;
		let left = 0;
		let right = 0;
		for (const it of items) {
			const x0 = it.x ?? 0;
			const x1 = x0 + (it.width ?? 0);
			if (x0 < g && x1 > g) crossing++;
			else if (center(it) < g) left++;
			else right++;
		}
		if (left > 3 && right > 3 && (best === null || crossing < best.crossing)) best = { g, crossing };
	}
	if (!best || best.crossing > Math.max(2, items.length * 0.08)) return [items];
	const left: TextItem[] = [];
	const right: TextItem[] = [];
	for (const it of items) (center(it) < best.g ? left : right).push(it);
	return [left, right];
}

// Reconstruct readable paragraph text from per-page geometry. Splits multi-column
// pages so columns read top-to-bottom (not interleaved), drops running
// headers/footers (lines repeated across ≥half the pages) and edge page numbers.
function reflowDocument(pages: LiteParsePage[]): string {
	const perPage = pages.map((p) => splitColumns(p.textItems ?? [], p.width ?? 0).map((col) => pageLines(col)));
	const freq = new Map<string, number>();
	for (const cols of perPage) {
		for (const key of new Set(cols.flat().map((l) => l.text.toLowerCase()))) {
			freq.set(key, (freq.get(key) ?? 0) + 1);
		}
	}
	const repeatThreshold = Math.max(2, Math.ceil(perPage.length * 0.5));
	const isEdgePageNumber = (l: Line, i: number, lines: Line[]) => /^\d{1,5}$/.test(l.text) && (i === 0 || i === lines.length - 1);
	const out: string[] = [];
	for (const cols of perPage) {
		for (const lines of cols) {
			const kept = lines.filter((l, i) => (freq.get(l.text.toLowerCase()) ?? 0) < repeatThreshold && !isEdgePageNumber(l, i, lines));
			out.push(...reflowLines(kept));
		}
	}
	return out.join('\n\n');
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
// the result. Shared by extractAndPersistPdf (workflow) and the /scrape endpoint.
export function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
	ensureWasm();
	const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'text' });
	return parser.parse(bytes).then((raw: LiteParseResult) => {
		const pages = raw.pages?.length ?? 0;
		const text = reflowDocument(raw.pages ?? []);
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
