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

/**
 * Resolve a paper identity from an article. Prefers the URL (unambiguous), then
 * scans the head of the extracted text when `scanContent` is set.
 */
export function detectPaperId(url: string, content: string | null, opts: { scanContent: boolean }): PaperDetection {
	let host = '';
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		// non-URL sources (uploads) fall through to content scanning
	}

	const urlArxiv = extractArxivId(url);
	if (urlArxiv) return { id: { kind: 'arxiv', value: urlArxiv }, hasAcademicMarker: true };

	if (host === 'doi.org' || host === 'dx.doi.org' || host.endsWith('arxiv.org')) {
		const urlDoi = extractDoi(url);
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
