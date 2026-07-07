// Identify academic papers from a URL and (optionally) extracted PDF text.
// URL detection is always safe (arxiv.org / doi.org hosts, or an arXiv id in the
// path). Full-text DOI scanning is opt-in (`scanContent`) and limited to the
// document head — a news article merely *mentioning* a DOI must not be mislabeled
// a paper, so we only scan content for uploads that we know are PDFs.

export type PaperId = { kind: 'doi'; value: string } | { kind: 'arxiv'; value: string };

/**
 * Detection result. `id` is a resolvable DOI/arXiv id (null when only a
 * placeholder or no id was found). `hasAcademicMarker` is true when the text
 * carries *any* DOI/arXiv signal — including an unassigned ACM template
 * placeholder (`10.1145/nnnnnnn.nnnnnnn`) — which tells the enricher this is a
 * paper worth resolving by title even though no id resolved.
 */
export type PaperDetection = { id: PaperId | null; hasAcademicMarker: boolean };

const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i;
const ARXIV_INLINE_RE = /arxiv[:\s]\s*(\d{4}\.\d{4,5})(?:v\d+)?/i;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i;
const CONTENT_SCAN_CHARS = 4_000;

/** Trailing punctuation that commonly gets glued onto a DOI in prose. */
function trimDoi(doi: string): string {
	return doi.replace(/[.,;)\]]+$/, '');
}

/**
 * Unassigned template DOIs (ACM `nnnnnnn.nnnnnnn`, generic `XXXXXXX`) look like
 * real DOIs but resolve to nothing. Treat them as an academic *marker* but never
 * as a usable id.
 */
function isPlaceholderDoi(doi: string): boolean {
	return /n{4,}|x{4,}/i.test(doi);
}

function extractArxivId(text: string): string | null {
	return text.match(ARXIV_URL_RE)?.[1] ?? text.match(ARXIV_INLINE_RE)?.[1] ?? null;
}

/** Returns the first DOI-like token and whether it's a usable (non-placeholder) DOI. */
function extractDoi(text: string): { value: string | null; marker: boolean } {
	const raw = text.match(DOI_RE)?.[1];
	if (!raw) return { value: null, marker: false };
	const doi = trimDoi(raw).toLowerCase();
	return isPlaceholderDoi(doi) ? { value: null, marker: true } : { value: doi, marker: true };
}

function titleTokens(title: string): Set<string> {
	return new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * Guard against title-search false positives without demanding an exact match:
 * Dice coefficient over word sets tolerates minor extraction noise while
 * unrelated papers score far below the threshold.
 */
export function titlesMatch(query: string, candidate: string): boolean {
	const a = titleTokens(query);
	const b = titleTokens(candidate);
	if (a.size < 3 || b.size < 3) return false;
	let overlap = 0;
	for (const token of a) if (b.has(token)) overlap++;
	return (2 * overlap) / (a.size + b.size) >= 0.75;
}

const TITLE_STOP_RE = /^(abstract|introduction|keywords|ccs concepts|acm reference|permission|copyright)/i;

/**
 * Extract a paper's real title from the head of its (markdown-ish) extracted
 * text — the leading heading lines, concatenated. This beats the filename-derived
 * title for metadata title matching: uploads carry noisy filenames (typos,
 * abbreviations) that no title search will match, whereas the PDF's own heading
 * is the real thing.
 */
export function extractPaperTitle(content: string): string | null {
	const lines = content
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const parts: string[] = [];
	for (const line of lines.slice(0, 15)) {
		const heading = line.match(/^#{1,3}\s+(.+)$/);
		if (!heading) {
			if (parts.length) break; // headings ended → title complete
			continue; // skip pre-title noise (page numbers, etc.)
		}
		const text = heading[1].trim();
		if (TITLE_STOP_RE.test(text)) break;
		parts.push(text);
	}
	const title = parts.join(' ').replace(/\s+/g, ' ').trim();
	return title.length >= 12 ? title : null;
}

/**
 * Resolve a paper identity from an article. Prefers the URL (unambiguous), then
 * scans the head of the extracted text when `scanContent` is set.
 */
export function detectPaperId(url: string | null | undefined, content: string | null, opts: { scanContent: boolean }): PaperDetection {
	// Blob uploads have a null source_url — never call String.match on null.
	const safeUrl = typeof url === 'string' ? url : '';
	let host = '';
	try {
		host = new URL(safeUrl).hostname.toLowerCase();
	} catch {
		// non-URL sources (uploads) fall through to content scanning
	}

	const urlArxiv = extractArxivId(safeUrl);
	if (urlArxiv) return { id: { kind: 'arxiv', value: urlArxiv }, hasAcademicMarker: true };

	if (host === 'doi.org' || host === 'dx.doi.org' || host.endsWith('arxiv.org')) {
		const urlDoi = extractDoi(safeUrl);
		if (urlDoi.value) return { id: { kind: 'doi', value: urlDoi.value }, hasAcademicMarker: true };
	}

	if (opts.scanContent && content) {
		const head = content.slice(0, CONTENT_SCAN_CHARS);
		const arxiv = extractArxivId(head);
		if (arxiv) return { id: { kind: 'arxiv', value: arxiv }, hasAcademicMarker: true };
		const doi = extractDoi(head);
		if (doi.value) return { id: { kind: 'doi', value: doi.value }, hasAcademicMarker: true };
		if (doi.marker) return { id: null, hasAcademicMarker: true };
	}

	return { id: null, hasAcademicMarker: false };
}
