// Semantic Scholar client for academic-paper enrichment. S2_API_KEY gives us a
// dedicated per-key rate, avoiding shared Worker egress IP rate limits, and S2
// returns reference metadata (DOI + author) in a single call.

import type { WorkflowStep } from 'cloudflare:workers';
import type { PaperMetadata, PaperReference } from '@core-shared/types';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/web';

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCES = 50;
const ARXIV_PATH_RE = /^\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\/?$/i;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i;

const PAPER_FIELDS = [
	'title',
	'year',
	'abstract',
	'venue',
	'citationCount',
	'referenceCount',
	'externalIds',
	'authors.name',
	'references.title',
	'references.year',
	'references.externalIds',
	'references.authors',
].join(',');

type PaperId = { kind: 'doi'; value: string } | { kind: 'arxiv'; value: string };

interface S2Author {
	name?: string;
}
interface S2ExternalIds {
	DOI?: string;
}
interface S2Ref {
	title?: string;
	year?: number | null;
	externalIds?: S2ExternalIds | null;
	authors?: S2Author[];
}
interface S2Paper {
	paperId?: string;
	title?: string | null;
	year?: number | null;
	abstract?: string | null;
	venue?: string | null;
	citationCount?: number | null;
	referenceCount?: number | null;
	externalIds?: S2ExternalIds | null;
	authors?: S2Author[];
	references?: S2Ref[];
}
function trimDoi(doi: string): string {
	return doi.replace(/[.,;)\]]+$/, '');
}

function isPlaceholderDoi(doi: string): boolean {
	return /n{4,}|x{4,}/i.test(doi);
}

function extractDoi(text: string): string | null {
	const raw = text.match(DOI_RE)?.[1];
	if (!raw) return null;
	const doi = trimDoi(raw).toLowerCase();
	return isPlaceholderDoi(doi) ? null : doi;
}

function detectPaperId(url: string | null | undefined): PaperId | null {
	const safeUrl = typeof url === 'string' ? url : '';
	let parsed: URL;
	try {
		parsed = new URL(safeUrl);
	} catch {
		return null;
	}
	const host = parsed.hostname.toLowerCase();

	if (host === 'arxiv.org' || host.endsWith('.arxiv.org')) {
		const arxivId = parsed.pathname.match(ARXIV_PATH_RE)?.[1];
		if (arxivId) return { kind: 'arxiv', value: arxivId };
	}

	if (host === 'doi.org' || host === 'dx.doi.org') {
		let doiPath = parsed.pathname.slice(1);
		try {
			doiPath = decodeURIComponent(doiPath);
		} catch {
			// Preserve malformed escapes; the DOI parser will reject them.
		}
		const doi = extractDoi(doiPath);
		if (doi) return { kind: 'doi', value: doi };
	}

	return null;
}

async function fetchS2<T>(path: string, apiKey?: string): Promise<T | null> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers['x-api-key'] = apiKey;
	const res = await fetchWithTimeout(`${S2_BASE}${path}`, { headers }, REQUEST_TIMEOUT_MS);
	if (res.ok) return JSON.parse(await readTextWithLimit(res, RESPONSE_MAX_BYTES)) as T;
	const status = res.status;
	await res.body?.cancel();
	if (status === 404) return null;
	if (status >= 400 && status < 500 && status !== 429) {
		console.warn({ tag: 'S2', msg: 'request rejected', status, path: path.slice(0, 80) });
		return null;
	}
	throw new Error(`Semantic Scholar request failed with HTTP ${status}`);
}

function authorNames(authors: S2Author[] | undefined): string[] {
	if (!authors) return [];
	return authors.map((a) => a.name).filter((name): name is string => !!name);
}

function normalizeReferences(references: S2Ref[] | undefined): PaperReference[] {
	if (!references) return [];
	return references.slice(0, MAX_REFERENCES).map((ref) => ({
		doi: ref.externalIds?.DOI?.toLowerCase(),
		title: ref.title ?? undefined,
		year: ref.year ?? undefined,
		author: authorNames(ref.authors)[0],
	}));
}

function normalizePaper(paper: S2Paper): PaperMetadata {
	const doi = paper.externalIds?.DOI?.toLowerCase();
	return {
		source: 'semanticscholar',
		doi,
		title: paper.title ?? undefined,
		authors: authorNames(paper.authors),
		abstract: paper.abstract ?? undefined,
		venue: paper.venue ?? undefined,
		year: paper.year ?? undefined,
		citedByCount: paper.citationCount ?? undefined,
		referenceCount: paper.referenceCount ?? paper.references?.length ?? 0,
		references: normalizeReferences(paper.references),
	};
}

function idPath(id: PaperId): string {
	return id.kind === 'doi' ? `DOI:${id.value}` : `ARXIV:${id.value}`;
}

/** Resolve a paper by DOI or arXiv id. Returns null when Semantic Scholar has no match. */
async function enrichS2FromId(id: PaperId, apiKey?: string): Promise<PaperMetadata | null> {
	const paper = await fetchS2<S2Paper>(`/paper/${idPath(id)}?fields=${PAPER_FIELDS}`, apiKey);
	if (!paper?.paperId) return null;
	return normalizePaper(paper);
}

async function enrichPaperMetadata(url: string, apiKey?: string): Promise<PaperMetadata | null> {
	const id = detectPaperId(url);
	const paper = id ? await enrichS2FromId(id, apiKey) : null;
	if (paper) console.info({ tag: 'S2', msg: 'Paper enriched', doi: paper.doi, refs: paper.references.length });
	return paper;
}

export async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: { url?: string | null },
): Promise<PaperMetadata | null> {
	const url = candidate.url?.trim();
	if (!url || !detectPaperId(url)) return null;

	return step.do(
		'enrich-paper-metadata',
		{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
		() => enrichPaperMetadata(url, env.S2_API_KEY),
	);
}
