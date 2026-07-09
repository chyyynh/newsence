// Semantic Scholar client for academic-paper enrichment. S2_API_KEY gives us a
// dedicated per-key rate, avoiding shared Worker egress IP rate limits, and S2
// returns reference metadata (DOI + author) in a single call.

import type { WorkflowStep } from 'cloudflare:workers';
import type { PaperMetadata, PaperReference } from '@core-shared/types';
import { fetchWithTimeout } from '@core-shared/web';
import { type CoreDb, withCoreTx } from '@db/client';
import { paperReferences, papers } from '@db/schema';
import { sql } from 'drizzle-orm';

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REFERENCES = 50;
const MAX_EDGES = 50;
const PDF_MIME = 'application/pdf';
const ARXIV_URL_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/i;
const ARXIV_INLINE_RE = /arxiv[:\s]\s*(\d{4}\.\d{4,5})(?:v\d+)?/i;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i;
const CONTENT_SCAN_CHARS = 4_000;
const TITLE_STOP_RE = /^(abstract|introduction|keywords|ccs concepts|acm reference|permission|copyright)/i;

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
type PaperDetection = { id: PaperId | null; hasAcademicMarker: boolean };

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
type PaperRow = {
	openAlexId: string;
	doi: string | null;
	articleId: string | null;
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

function extractPaperTitle(content: string): string | null {
	const lines = content
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const parts: string[] = [];
	for (const line of lines.slice(0, 15)) {
		const heading = line.match(/^#{1,3}\s+(.+)$/);
		if (!heading) {
			if (parts.length) break;
			continue;
		}
		const text = heading[1].trim();
		if (TITLE_STOP_RE.test(text)) break;
		parts.push(text);
	}
	const title = parts.join(' ').replace(/\s+/g, ' ').trim();
	return title.length >= 12 ? title : null;
}

function detectPaperId(url: string | null | undefined, content: string | null, scanContent: boolean): PaperDetection {
	const safeUrl = typeof url === 'string' ? url : '';
	let host = '';
	try {
		host = new URL(safeUrl).hostname.toLowerCase();
	} catch {
		// non-URL sources, such as uploads, fall through to content scanning
	}

	const urlArxiv = extractArxivId(safeUrl);
	if (urlArxiv) return { id: { kind: 'arxiv', value: urlArxiv }, hasAcademicMarker: true };

	if (host === 'doi.org' || host === 'dx.doi.org' || host.endsWith('arxiv.org')) {
		const urlDoi = extractDoi(safeUrl);
		if (urlDoi.value) return { id: { kind: 'doi', value: urlDoi.value }, hasAcademicMarker: true };
	}

	if (scanContent && content) {
		const head = content.slice(0, CONTENT_SCAN_CHARS);
		const arxiv = extractArxivId(head);
		if (arxiv) return { id: { kind: 'arxiv', value: arxiv }, hasAcademicMarker: true };
		const doi = extractDoi(head);
		if (doi.value) return { id: { kind: 'doi', value: doi.value }, hasAcademicMarker: true };
		if (doi.marker) return { id: null, hasAcademicMarker: true };
	}

	return { id: null, hasAcademicMarker: false };
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
				await scheduler.wait(retryAfter * 1000);
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

function titleTokens(title: string): Set<string> {
	return new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function titlesMatch(query: string, candidate: string): boolean {
	const a = titleTokens(query);
	const b = titleTokens(candidate);
	if (a.size < 3 || b.size < 3) return false;
	let overlap = 0;
	for (const token of a) if (b.has(token)) overlap++;
	return (2 * overlap) / (a.size + b.size) >= 0.75;
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
			articleId: row.articleId,
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
				articleId: sql`COALESCE(excluded.article_id, ${papers.articleId})`,
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

async function syncPaperGraph(env: CoreEnv, articleId: string, paper: PaperMetadata): Promise<{ edges: number } | null> {
	const openAlexId = paper.openAlexId;
	if (!openAlexId) return null;

	return withCoreTx(env, async (db) => {
		const fromId = await upsertIngestedPaper(db, {
			openAlexId,
			doi: paper.doi ?? null,
			articleId,
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

/** Resolve a paper by DOI or arXiv id. Returns null on miss / error — never throws. */
async function enrichS2FromId(id: PaperId, apiKey?: string): Promise<PaperMetadata | null> {
	const paper = await fetchS2<S2Paper>(`/paper/${idPath(id)}?fields=${PAPER_FIELDS}`, apiKey);
	if (!paper?.paperId) return null;
	return normalizePaper(paper, id.kind === 'arxiv' ? id.value : undefined);
}

/**
 * Resolve a paper by title. Two calls: (1) the title-match endpoint returns the
 * single best fuzzy match's id (it does NOT support `references.*` fields and
 * 400s on some punctuation, so query a lite, punctuation-stripped title), then
 * (2) fetch full metadata + references by paperId, then verify the match
 * against the original title.
 */
async function enrichS2ByTitle(title: string, apiKey?: string): Promise<PaperMetadata | null> {
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

async function enrichPaperMetadata(
	candidate: { url?: string | null; title: string; fileType?: string | null; content?: string | null },
	apiKey?: string,
): Promise<PaperMetadata | null> {
	const content = candidate.content ?? null;
	const detection = detectPaperId(candidate.url, content, !!content);
	const searchTitle = (content ? extractPaperTitle(content) : null) ?? candidate.title;
	const canTitleSearch = detection.hasAcademicMarker || candidate.fileType === PDF_MIME;
	const paper =
		(detection.id ? await enrichS2FromId(detection.id, apiKey) : null) ??
		(canTitleSearch && searchTitle ? await enrichS2ByTitle(searchTitle, apiKey) : null);

	if (paper) console.info({ tag: 'S2', msg: 'Paper enriched', doi: paper.doi, refs: paper.references.length });

	return paper;
}

export async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: { url?: string | null; title: string; file_type?: string | null },
	input: { hasStagedText: boolean; loadContent: () => Promise<string | null | undefined> },
): Promise<PaperMetadata | null> {
	if (!input.hasStagedText && candidate.file_type !== PDF_MIME && !detectPaperId(candidate.url, null, false).hasAcademicMarker) return null;

	try {
		return await step.do(
			'enrich-paper-metadata',
			{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			async () =>
				enrichPaperMetadata(
					{ url: candidate.url, title: candidate.title, fileType: candidate.file_type, content: await input.loadContent() },
					env.S2_API_KEY,
				),
		);
	} catch (error) {
		console.warn({ tag: 'WORKFLOW', msg: 'Paper enrichment failed, continuing', url: candidate.url, error: String(error) });
		return null;
	}
}

export async function syncPaperGraphForEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	articleId: string,
	paperEnrichment: PaperMetadata | null,
): Promise<void> {
	if (!paperEnrichment?.openAlexId) return;
	try {
		const summary = await step.do(
			'sync-paper-graph',
			{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
			() => syncPaperGraph(env, articleId, paperEnrichment),
		);
		console.info({ tag: 'WORKFLOW', msg: 'Paper graph synced', article_id: articleId, edges: summary?.edges ?? 0 });
	} catch (error) {
		console.warn({ tag: 'WORKFLOW', msg: 'Paper graph sync failed, continuing', article_id: articleId, error: String(error) });
	}
}
