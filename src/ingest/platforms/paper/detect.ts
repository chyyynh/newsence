// Identify academic papers from a URL and (optionally) extracted PDF text.
// URL detection is always safe (arxiv.org / doi.org hosts, or an arXiv id in the
// path). Full-text DOI scanning is opt-in (`scanContent`) and limited to the
// document head — a news article merely *mentioning* a DOI must not be mislabeled
// a paper, so we only scan content for uploads that we know are PDFs.

export type PaperId = { kind: 'doi'; value: string } | { kind: 'arxiv'; value: string };

const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i;
const ARXIV_INLINE_RE = /arxiv[:\s]\s*(\d{4}\.\d{4,5})(?:v\d+)?/i;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i;
const CONTENT_SCAN_CHARS = 4_000;

/** Trailing punctuation that commonly gets glued onto a DOI in prose. */
function trimDoi(doi: string): string {
	return doi.replace(/[.,;)\]]+$/, '');
}

function extractArxivId(text: string): string | null {
	return text.match(ARXIV_URL_RE)?.[1] ?? text.match(ARXIV_INLINE_RE)?.[1] ?? null;
}

function extractDoi(text: string): string | null {
	const raw = text.match(DOI_RE)?.[1];
	return raw ? trimDoi(raw).toLowerCase() : null;
}

/**
 * Resolve a paper identity from an article. Prefers the URL (unambiguous), then
 * falls back to scanning the head of the extracted text when `scanContent` is
 * set. Returns null for anything that isn't recognizably a paper.
 */
export function detectPaperId(url: string, content: string | null, opts: { scanContent: boolean }): PaperId | null {
	let host = '';
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		// non-URL sources (uploads) fall through to content scanning
	}

	const urlArxiv = extractArxivId(url);
	if (urlArxiv) return { kind: 'arxiv', value: urlArxiv };

	if (host === 'doi.org' || host === 'dx.doi.org' || host.endsWith('arxiv.org')) {
		const urlDoi = extractDoi(url);
		if (urlDoi) return { kind: 'doi', value: urlDoi };
	}

	if (opts.scanContent && content) {
		const head = content.slice(0, CONTENT_SCAN_CHARS);
		const arxiv = extractArxivId(head);
		if (arxiv) return { kind: 'arxiv', value: arxiv };
		const doi = extractDoi(head);
		if (doi) return { kind: 'doi', value: doi };
	}

	return null;
}
