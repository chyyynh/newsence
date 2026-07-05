// OpenAlex client for academic-paper enrichment. We deliberately do NOT parse
// references out of the PDF (unreliable, and GROBID can't run on Workers) —
// given a DOI/arXiv id, OpenAlex returns clean structured metadata plus the
// reference graph in a couple of fetches.
//
// arXiv note: OpenAlex indexes arXiv preprints under the DataCite DOI
// `10.48550/arXiv.<id>`. References are frequently empty for preprints (OpenAlex
// only has them once a work is Crossref-linked) — enrichment still succeeds, the
// reference list is just short. All failures degrade to null; callers treat this
// step as best-effort and never fail the workflow on it.

import type { PaperMetadata, PaperReference } from '@shared/platform-metadata';
import { fetchWithTimeout } from '@shared/web';
import type { PaperId } from './detect';

const OPENALEX_BASE = 'https://api.openalex.org/works';
const POLITE_MAILTO = 'hello@newsence.app';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REFERENCES = 50;

const WORK_SELECT =
	'id,doi,title,display_name,publication_year,cited_by_count,referenced_works,authorships,primary_location,best_oa_location,open_access,abstract_inverted_index';
const REF_SELECT = 'id,doi,title,display_name,publication_year,authorships';

// ── OpenAlex response shapes (only the fields we read) ───────────
interface OaAuthorship {
	author?: { display_name?: string };
}
interface OaLocation {
	pdf_url?: string | null;
	landing_page_url?: string | null;
	source?: { display_name?: string } | null;
}
interface OaWork {
	id?: string;
	doi?: string | null;
	title?: string | null;
	display_name?: string | null;
	publication_year?: number | null;
	cited_by_count?: number | null;
	referenced_works?: string[];
	authorships?: OaAuthorship[];
	primary_location?: OaLocation | null;
	best_oa_location?: OaLocation | null;
	open_access?: { oa_url?: string | null } | null;
	abstract_inverted_index?: Record<string, number[]> | null;
}
interface OaListResponse {
	results?: OaWork[];
}

function buildUrl(params: Record<string, string>): string {
	const search = new URLSearchParams({ mailto: POLITE_MAILTO, ...params });
	return `${OPENALEX_BASE}?${search.toString()}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
	const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, REQUEST_TIMEOUT_MS);
	if (!res.ok) {
		await res.body?.cancel();
		return null;
	}
	return (await res.json()) as T;
}

/** OpenAlex work URLs are `https://openalex.org/W123` — the filter wants the bare id. */
function shortId(idUrl: string | undefined): string | null {
	if (!idUrl) return null;
	const tail = idUrl.split('/').pop();
	return tail && /^W\d+$/i.test(tail) ? tail : null;
}

function stripDoiUrl(doi: string | null | undefined): string | undefined {
	if (!doi) return undefined;
	return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
}

/** Reconstruct plain-text abstract from OpenAlex's inverted index. */
function reconstructAbstract(inverted: Record<string, number[]> | null | undefined): string | undefined {
	if (!inverted) return undefined;
	const slots: string[] = [];
	for (const [word, positions] of Object.entries(inverted)) {
		for (const pos of positions) slots[pos] = word;
	}
	const text = slots.join(' ').replace(/\s+/g, ' ').trim();
	return text.length > 0 ? text.slice(0, 2_000) : undefined;
}

function authorNames(authorships: OaAuthorship[] | undefined): string[] {
	if (!authorships) return [];
	return authorships.map((a) => a.author?.display_name).filter((name): name is string => !!name);
}

async function resolveReferences(referencedWorks: string[]): Promise<PaperReference[]> {
	const ids = referencedWorks
		.map(shortId)
		.filter((id): id is string => id !== null)
		.slice(0, MAX_REFERENCES);
	if (ids.length === 0) return [];

	try {
		const url = buildUrl({ filter: `openalex_id:${ids.join('|')}`, select: REF_SELECT, 'per-page': String(ids.length) });
		const data = await fetchJson<OaListResponse>(url);
		if (!data?.results) return ids.map((id) => ({ openAlexId: id }));

		const byId = new Map<string, OaWork>();
		for (const work of data.results) {
			const id = shortId(work.id);
			if (id) byId.set(id, work);
		}
		// Preserve the paper's own reference ordering; unresolved ids keep just the id.
		return ids.map((id) => {
			const work = byId.get(id);
			if (!work) return { openAlexId: id };
			return {
				openAlexId: id,
				doi: stripDoiUrl(work.doi),
				title: work.title ?? work.display_name ?? undefined,
				year: work.publication_year ?? undefined,
				author: authorNames(work.authorships)[0],
			};
		});
	} catch {
		return ids.map((id) => ({ openAlexId: id }));
	}
}

async function normalizeWork(work: OaWork, arxivHint?: string): Promise<PaperMetadata> {
	const bestPdf = work.best_oa_location?.pdf_url ?? work.open_access?.oa_url ?? undefined;
	const landing = work.primary_location?.landing_page_url ?? undefined;
	const venue = work.primary_location?.source?.display_name ?? work.best_oa_location?.source?.display_name ?? undefined;
	const references = await resolveReferences(work.referenced_works ?? []);
	return {
		source: 'openalex',
		openAlexId: shortId(work.id) ?? undefined,
		doi: stripDoiUrl(work.doi),
		arxivId: arxivHint,
		title: work.title ?? work.display_name ?? undefined,
		authors: authorNames(work.authorships),
		abstract: reconstructAbstract(work.abstract_inverted_index),
		venue,
		year: work.publication_year ?? undefined,
		citedByCount: work.cited_by_count ?? undefined,
		referenceCount: work.referenced_works?.length ?? 0,
		oaPdfUrl: bestPdf ?? undefined,
		landingPageUrl: landing,
		references,
	};
}

function doiFilterFor(id: PaperId): string {
	return id.kind === 'doi' ? id.value : `10.48550/arxiv.${id.value}`;
}

function titleTokens(title: string): Set<string> {
	return new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * Guard against title-search false positives without demanding an exact match:
 * Dice coefficient over word sets tolerates minor extraction noise (a duplicated
 * wrapped word, a dropped stopword) while unrelated papers score far below the
 * threshold.
 */
function titlesMatch(query: string, candidate: string): boolean {
	const a = titleTokens(query);
	const b = titleTokens(candidate);
	if (a.size < 3 || b.size < 3) return false;
	let overlap = 0;
	for (const token of a) if (b.has(token)) overlap++;
	const dice = (2 * overlap) / (a.size + b.size);
	return dice >= 0.75;
}

/**
 * Resolve a paper's metadata + references from a DOI or arXiv id. Returns null
 * when OpenAlex has no record or any network error occurs — never throws.
 */
export async function enrichPaperFromId(id: PaperId): Promise<PaperMetadata | null> {
	try {
		const url = buildUrl({ filter: `doi:${doiFilterFor(id)}`, select: WORK_SELECT, 'per-page': '1' });
		const data = await fetchJson<OaListResponse>(url);
		const work = data?.results?.[0];
		if (!work) return null;
		return normalizeWork(work, id.kind === 'arxiv' ? id.value : undefined);
	} catch {
		return null;
	}
}

/**
 * Fallback for papers whose printed DOI is a placeholder / unassigned (common in
 * preprints & camera-ready drafts): search OpenAlex by title and accept the top
 * hit only if its title matches (guards against grabbing an unrelated work).
 */
export async function enrichPaperByTitle(title: string): Promise<PaperMetadata | null> {
	const trimmed = title.trim();
	if (trimmed.length < 12) return null;
	try {
		const url = buildUrl({ filter: `title.search:${trimmed}`, select: WORK_SELECT, 'per-page': '3' });
		const data = await fetchJson<OaListResponse>(url);
		const work = (data?.results ?? []).find((w) => titlesMatch(trimmed, w.title ?? w.display_name ?? ''));
		if (!work) return null;
		return normalizeWork(work);
	} catch {
		return null;
	}
}
