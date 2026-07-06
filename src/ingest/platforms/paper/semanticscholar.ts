// Semantic Scholar client for academic-paper enrichment. Preferred over OpenAlex
// because OpenAlex rate-limits by IP and Cloudflare Workers share egress IPs
// (chronic 429s). S2's unauthenticated limit is a *global shared pool*, not
// per-IP, so it survives the shared Worker IP; an optional S2_API_KEY grants a
// dedicated per-key rate. S2 also returns richer reference metadata (DOI +
// author) in a single call.

import type { PaperMetadata, PaperReference } from '@core-shared/platform-metadata';
import { fetchWithTimeout } from '@core-shared/web';
import { type PaperId, titlesMatch } from './detect';

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REFERENCES = 50;

const PAPER_FIELDS = [
	'title',
	'year',
	'abstract',
	'venue',
	'citationCount',
	'referenceCount',
	'externalIds',
	'authors.name',
	'openAccessPdf',
	'references.title',
	'references.year',
	'references.externalIds',
	'references.authors',
].join(',');

// ── S2 response shapes (only the fields we read) ─────────────────
interface S2Author {
	name?: string;
}
interface S2ExternalIds {
	DOI?: string;
	ArXiv?: string;
}
interface S2Ref {
	paperId?: string;
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
	openAccessPdf?: { url?: string | null } | null;
	references?: S2Ref[];
}
interface S2MatchResponse {
	data?: S2Paper[];
}

async function fetchS2<T>(path: string, apiKey?: string): Promise<T | null> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers['x-api-key'] = apiKey;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetchWithTimeout(`${S2_BASE}${path}`, { headers }, REQUEST_TIMEOUT_MS);
			if (res.ok) return (await res.json()) as T;
			if (res.status === 429 && attempt < 2) {
				const retryAfter = Math.min(Number.parseInt(res.headers.get('retry-after') ?? '', 10) || 2, 5);
				await res.body?.cancel();
				await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
				continue;
			}
			console.warn({ tag: 'S2', msg: 'non-ok', status: res.status, path: path.slice(0, 80) });
			await res.body?.cancel();
			return null;
		} catch (error) {
			console.warn({ tag: 'S2', msg: 'fetch threw', error: String(error) });
			return null;
		}
	}
	return null;
}

function authorNames(authors: S2Author[] | undefined): string[] {
	if (!authors) return [];
	return authors.map((a) => a.name).filter((name): name is string => !!name);
}

function normalizeReferences(references: S2Ref[] | undefined): PaperReference[] {
	if (!references) return [];
	return references.slice(0, MAX_REFERENCES).map((ref) => ({
		openAlexId: ref.paperId, // source-native id (S2 paperId); used only for a link fallback
		doi: ref.externalIds?.DOI?.toLowerCase(),
		title: ref.title ?? undefined,
		year: ref.year ?? undefined,
		author: authorNames(ref.authors)[0],
	}));
}

function normalizePaper(paper: S2Paper, arxivHint?: string): PaperMetadata {
	const doi = paper.externalIds?.DOI?.toLowerCase();
	return {
		source: 'semanticscholar',
		openAlexId: paper.paperId,
		doi,
		arxivId: arxivHint ?? paper.externalIds?.ArXiv ?? undefined,
		title: paper.title ?? undefined,
		authors: authorNames(paper.authors),
		abstract: paper.abstract ?? undefined,
		venue: paper.venue ?? undefined,
		year: paper.year ?? undefined,
		citedByCount: paper.citationCount ?? undefined,
		referenceCount: paper.referenceCount ?? paper.references?.length ?? 0,
		oaPdfUrl: paper.openAccessPdf?.url ?? undefined,
		landingPageUrl: doi ? `https://doi.org/${doi}` : undefined,
		references: normalizeReferences(paper.references),
	};
}

function idPath(id: PaperId): string {
	return id.kind === 'doi' ? `DOI:${id.value}` : `ARXIV:${id.value}`;
}

/** Resolve a paper by DOI or arXiv id. Returns null on miss / error — never throws. */
export async function enrichS2FromId(id: PaperId, apiKey?: string): Promise<PaperMetadata | null> {
	const paper = await fetchS2<S2Paper>(`/paper/${idPath(id)}?fields=${PAPER_FIELDS}`, apiKey);
	if (!paper?.paperId) return null;
	return normalizePaper(paper, id.kind === 'arxiv' ? id.value : undefined);
}

/**
 * Resolve a paper by title. Two calls: (1) the title-match endpoint returns the
 * single best fuzzy match's id (it does NOT support `references.*` fields and
 * 400s on some punctuation, so query a lite, punctuation-stripped title), then
 * (2) fetch full metadata + references by paperId. titlesMatch verifies the
 * match against the original title.
 */
export async function enrichS2ByTitle(title: string, apiKey?: string): Promise<PaperMetadata | null> {
	const trimmed = title.trim();
	if (trimmed.length < 12) return null;
	const query = encodeURIComponent(
		trimmed
			.replace(/[^\p{L}\p{N}\s]/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	);
	const match = await fetchS2<S2MatchResponse>(`/paper/search/match?query=${query}&fields=title`, apiKey);
	const hit = match?.data?.[0];
	if (!hit?.paperId || !titlesMatch(trimmed, hit.title ?? '')) return null;
	const paper = await fetchS2<S2Paper>(`/paper/${hit.paperId}?fields=${PAPER_FIELDS}`, apiKey);
	if (!paper?.paperId) return null;
	return normalizePaper(paper);
}
