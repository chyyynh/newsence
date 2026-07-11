// Semantic Scholar client for academic-paper enrichment. S2_API_KEY gives us a
// dedicated per-key rate, avoiding shared Worker egress IP rate limits, and S2
// returns reference metadata (DOI + author) in a single call.

import type { WorkflowStep } from 'cloudflare:workers';
import type { PaperMetadata, PaperReference } from '@core-shared/types';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { type CoreDb, withCoreTx } from '@db/client';
import { paperReferences, papers } from '@db/schema';
import { sql } from 'drizzle-orm';

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCES = 50;
const MAX_EDGES = 50;
const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i;
const ARXIV_INLINE_RE = /arxiv[:\s]\s*(\d{4}\.\d{4,5})(?:v\d+)?/i;
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
	'openAccessPdf',
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
type PaperRow = {
	openAlexId: string;
	doi: string | null;
	resourceId: string | null;
	title: string | null;
	authors: string[];
	venue: string | null;
	year: number | null;
	abstract: string | null;
	citedByCount: number | null;
	oaPdfUrl: string | null;
};

function trimDoi(doi: string): string {
	return doi.replace(/[.,;)\]]+$/, '');
}

function isPlaceholderDoi(doi: string): boolean {
	return /n{4,}|x{4,}/i.test(doi);
}

function extractArxivId(text: string): string | null {
	return text.match(ARXIV_URL_RE)?.[1] ?? text.match(ARXIV_INLINE_RE)?.[1] ?? null;
}

function extractDoi(text: string): { value: string | null; marker: boolean } {
	const raw = text.match(DOI_RE)?.[1];
	if (!raw) return { value: null, marker: false };
	const doi = trimDoi(raw).toLowerCase();
	return isPlaceholderDoi(doi) ? { value: null, marker: true } : { value: doi, marker: true };
}

function detectPaperId(url: string | null | undefined): PaperId | null {
	const safeUrl = typeof url === 'string' ? url : '';
	let host = '';
	try {
		host = new URL(safeUrl).hostname.toLowerCase();
	} catch {
		// Non-URL resources are not implicitly classified as academic works.
	}

	const urlArxiv = extractArxivId(safeUrl);
	if (urlArxiv) return { kind: 'arxiv', value: urlArxiv };

	if (host === 'doi.org' || host === 'dx.doi.org' || host.endsWith('arxiv.org')) {
		const urlDoi = extractDoi(safeUrl);
		if (urlDoi.value) return { kind: 'doi', value: urlDoi.value };
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

async function upsertIngestedPaper(db: CoreDb, row: PaperRow): Promise<string> {
	const [result] = await db
		.insert(papers)
		.values({
			openAlexId: row.openAlexId,
			doi: row.doi,
			resourceId: row.resourceId,
			title: row.title,
			authors: row.authors,
			venue: row.venue,
			year: row.year,
			abstract: row.abstract,
			citedByCount: row.citedByCount,
			oaPdfUrl: row.oaPdfUrl,
		})
		.onConflictDoUpdate({
			target: papers.openAlexId,
			set: {
				doi: sql`COALESCE(excluded.doi, ${papers.doi})`,
				resourceId: sql`COALESCE(excluded.resource_id, ${papers.resourceId})`,
				title: sql`COALESCE(excluded.title, ${papers.title})`,
				authors: sql`CASE WHEN cardinality(excluded.authors) > 0 THEN excluded.authors ELSE ${papers.authors} END`,
				venue: sql`COALESCE(excluded.venue, ${papers.venue})`,
				year: sql`COALESCE(excluded.year, ${papers.year})`,
				abstract: sql`COALESCE(excluded.abstract, ${papers.abstract})`,
				citedByCount: sql`COALESCE(excluded.cited_by_count, ${papers.citedByCount})`,
				oaPdfUrl: sql`COALESCE(excluded.oa_pdf_url, ${papers.oaPdfUrl})`,
				updatedAt: sql`NOW()`,
			},
		})
		.returning({ id: papers.id });
	const id = result?.id;
	if (!id) throw new Error(`Failed to upsert paper ${row.openAlexId}`);
	return id;
}

async function upsertReferenceNode(db: CoreDb, ref: PaperReference): Promise<string | null> {
	if (!ref.openAlexId) return null;
	const [result] = await db
		.insert(papers)
		.values({
			openAlexId: ref.openAlexId,
			doi: ref.doi ?? null,
			title: ref.title ?? null,
			authors: ref.author ? [ref.author] : [],
			year: ref.year ?? null,
		})
		.onConflictDoUpdate({
			target: papers.openAlexId,
			set: {
				doi: sql`COALESCE(excluded.doi, ${papers.doi})`,
				title: sql`COALESCE(${papers.title}, excluded.title)`,
				year: sql`COALESCE(${papers.year}, excluded.year)`,
				updatedAt: sql`NOW()`,
			},
		})
		.returning({ id: papers.id });
	return result?.id ?? null;
}

async function syncPaperGraph(env: CoreEnv, resourceId: string, paper: PaperMetadata): Promise<{ edges: number } | null> {
	const openAlexId = paper.openAlexId;
	if (!openAlexId) return null;

	return withCoreTx(env, async (db) => {
		const fromId = await upsertIngestedPaper(db, {
			openAlexId,
			doi: paper.doi ?? null,
			resourceId,
			title: paper.title ?? null,
			authors: paper.authors ?? [],
			venue: paper.venue ?? null,
			year: paper.year ?? null,
			abstract: paper.abstract ?? null,
			citedByCount: paper.citedByCount ?? null,
			oaPdfUrl: paper.oaPdfUrl ?? null,
		});

		const refs = (paper.references ?? []).filter((ref) => ref.openAlexId).slice(0, MAX_EDGES);
		let edges = 0;
		for (let ordinal = 0; ordinal < refs.length; ordinal++) {
			const toId = await upsertReferenceNode(db, refs[ordinal]);
			if (!toId || toId === fromId) continue;
			await db.insert(paperReferences).values({ fromPaperId: fromId, toPaperId: toId, ordinal }).onConflictDoNothing();
			edges++;
		}
		return { edges };
	});
}

function idPath(id: PaperId): string {
	return id.kind === 'doi' ? `DOI:${id.value}` : `ARXIV:${id.value}`;
}

/** Resolve a paper by DOI or arXiv id. Returns null when Semantic Scholar has no match. */
async function enrichS2FromId(id: PaperId, apiKey?: string): Promise<PaperMetadata | null> {
	const paper = await fetchS2<S2Paper>(`/paper/${idPath(id)}?fields=${PAPER_FIELDS}`, apiKey);
	if (!paper?.paperId) return null;
	return normalizePaper(paper, id.kind === 'arxiv' ? id.value : undefined);
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

export async function syncPaperGraphForEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	resourceId: string,
	paperEnrichment: PaperMetadata | null,
): Promise<void> {
	if (!paperEnrichment?.openAlexId) return;
	const summary = await step.do(
		'sync-paper-graph',
		{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
		() => syncPaperGraph(env, resourceId, paperEnrichment),
	);
	console.info({ tag: 'WORKFLOW', msg: 'Paper graph synced', resource_id: resourceId, edges: summary?.edges ?? 0 });
}
