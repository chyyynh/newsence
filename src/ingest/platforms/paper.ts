// Semantic Scholar client for academic-paper enrichment. S2_API_KEY gives us a
// dedicated per-key rate, avoiding shared Worker egress IP rate limits, and S2
// returns reference metadata (DOI + author) in a single call.

import type { WorkflowDynamicDelayContext, WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import type { PaperMetadata, PaperReference, PlatformMetadata, ResourceForProcessing } from '@core-shared/types';
import { z } from 'zod';

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const REQUEST_TIMEOUT_MS = 8_000;
// Semantic Scholar's paper-details response is capped at 10 MB. Match the
// provider boundary so the complete bibliography is retained when it fits.
const RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 15;
const MAX_RATE_LIMIT_DELAY_SECONDS = 5 * 60;
const ARXIV_PATH_RE = /^\/(?:abs|html|pdf)\/(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?\/?$/i;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9]+)/i;

const PAPER_FIELDS = [
	'title',
	'year',
	'publicationDate',
	'publicationTypes',
	'abstract',
	'venue',
	'citationCount',
	'referenceCount',
	'openAccessPdf',
	'externalIds',
	'authors.name',
	'references.title',
	'references.year',
	'references.url',
	'references.externalIds',
	'references.authors',
].join(',');

type PaperId = { kind: 'doi'; value: string } | { kind: 'arxiv'; value: string; versionedValue: string };
type PaperEnrichmentCandidate = {
	id: string;
	url?: string | null;
	platform_metadata?: Pick<PlatformMetadata, 'enrichments'>;
	hasExistingAcademic?: boolean;
};

export type PaperEnrichmentAttempt = {
	metadata: PaperMetadata | null;
	outcome: 'resolved' | 'preserved' | 'not_found' | 'failed' | 'not_applicable';
};

const S2AuthorSchema = z.object({ name: z.string().nullish() });
const S2ExternalIdsSchema = z.object({ DOI: z.string().nullish() });
const S2ReferenceSchema = z.object({
	paperId: z.string().nullish(),
	title: z.string().nullish(),
	year: z.number().int().nullish(),
	url: z.string().nullish(),
	externalIds: S2ExternalIdsSchema.nullish(),
	authors: z.array(S2AuthorSchema).nullish(),
});
const S2PaperSchema = z.object({
	paperId: z.string().nullish(),
	title: z.string().nullish(),
	year: z.number().int().nullish(),
	publicationDate: z.string().nullish(),
	publicationTypes: z.array(z.string()).nullish(),
	abstract: z.string().nullish(),
	venue: z.string().nullish(),
	citationCount: z.number().int().nonnegative().nullish(),
	referenceCount: z.number().int().nonnegative().nullish(),
	openAccessPdf: z.object({ url: z.string().nullish() }).nullish(),
	externalIds: S2ExternalIdsSchema.nullish(),
	authors: z.array(S2AuthorSchema).nullish(),
	references: z.array(S2ReferenceSchema).nullish(),
});

type S2Author = z.infer<typeof S2AuthorSchema>;
type S2Ref = z.infer<typeof S2ReferenceSchema>;
type S2Paper = z.infer<typeof S2PaperSchema>;
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
		const match = parsed.pathname.match(ARXIV_PATH_RE);
		const arxivId = match?.[1];
		if (arxivId) return { kind: 'arxiv', value: arxivId, versionedValue: `${arxivId}${match?.[2] ?? ''}` };
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

export function isExplicitPaperUrl(url: string | null | undefined): boolean {
	return detectPaperId(url) !== null;
}

async function fetchS2Paper(path: string, apiKey?: string): Promise<S2Paper | null> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (apiKey) headers['x-api-key'] = apiKey;
	const res = await fetchWithTimeout(`${S2_BASE}${path}`, { headers }, REQUEST_TIMEOUT_MS);
	if (res.ok) return S2PaperSchema.parse(JSON.parse(await readTextWithLimit(res, RESPONSE_MAX_BYTES)));
	const status = res.status;
	const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get('retry-after'));
	await res.body?.cancel();
	if (status === 404) return null;
	if (status === 429) {
		throw new Error(
			retryAfterSeconds === null
				? 'Semantic Scholar request failed with HTTP 429'
				: `Semantic Scholar request failed with HTTP 429; retry_after_seconds=${retryAfterSeconds}`,
		);
	}
	throw new Error(`Semantic Scholar request failed with HTTP ${status}`);
}

function parseRetryAfterSeconds(value: string | null): number | null {
	if (!value?.trim()) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, Math.max(1, Math.ceil(seconds)));
	}
	const retryAt = Date.parse(value);
	if (Number.isNaN(retryAt)) return null;
	return Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)));
}

function paperEnrichmentRetryDelay({ ctx, error }: WorkflowDynamicDelayContext): WorkflowSleepDuration {
	const requestedDelay = error.message.match(/retry_after_seconds=(\d+)/)?.[1];
	if (requestedDelay) {
		const seconds = Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, Math.max(1, Number(requestedDelay)));
		return `${seconds} seconds`;
	}
	if (error.message.includes('HTTP 429')) {
		return `${Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, ctx.attempt * DEFAULT_RATE_LIMIT_DELAY_SECONDS)} seconds`;
	}
	return `${Math.min(30, ctx.attempt * 5)} seconds`;
}

function authorNames(authors: S2Author[] | null | undefined): string[] {
	if (!authors) return [];
	return authors.map((a) => a.name).filter((name): name is string => !!name);
}

function normalizeReferences(references: S2Ref[] | null | undefined): PaperReference[] {
	if (!references) return [];
	return references.map((ref) => {
		const authors = authorNames(ref.authors);
		return {
			paperId: ref.paperId ?? undefined,
			doi: ref.externalIds?.DOI?.toLowerCase(),
			url: normalizeHttpsUrl(ref.url),
			title: ref.title ?? undefined,
			year: ref.year ?? undefined,
			authors,
			author: authors[0],
		};
	});
}

function normalizePublicationDate(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return undefined;
	const parsed = new Date(`${trimmed}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed ? undefined : trimmed;
}

function normalizeHttpsUrl(value: string | null | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function paperPdfUrl(id: PaperId, paper: S2Paper): string | undefined {
	if (id.kind === 'arxiv') return `https://arxiv.org/pdf/${id.versionedValue}`;
	return normalizeHttpsUrl(paper.openAccessPdf?.url);
}

function normalizePaper(id: PaperId, paper: S2Paper): PaperMetadata {
	const doi = paper.externalIds?.DOI?.toLowerCase();
	const references = normalizeReferences(paper.references);
	const fetchedAt = new Date().toISOString();
	return {
		schemaVersion: 2,
		source: 'semanticscholar',
		resolvedAt: fetchedAt,
		metricsUpdatedAt: fetchedAt,
		doi,
		title: paper.title ?? undefined,
		authors: authorNames(paper.authors),
		abstract: paper.abstract ?? undefined,
		venue: paper.venue ?? undefined,
		year: paper.year ?? undefined,
		publicationDate: normalizePublicationDate(paper.publicationDate),
		publicationTypes: paper.publicationTypes?.map((value) => value.trim()).filter(Boolean),
		citedByCount: paper.citationCount ?? undefined,
		referenceCount: paper.referenceCount ?? undefined,
		pdfUrl: paperPdfUrl(id, paper),
		references,
		referencesTruncated: typeof paper.referenceCount === 'number' && paper.referenceCount > references.length,
	};
}

function idPath(id: PaperId): string {
	return id.kind === 'doi' ? `DOI:${id.value}` : `ARXIV:${id.value}`;
}

/** Resolve a paper by DOI or arXiv id. Returns null when Semantic Scholar has no match. */
async function enrichS2FromId(id: PaperId, apiKey?: string): Promise<PaperMetadata | null> {
	const paper = await fetchS2Paper(`/paper/${idPath(id)}?fields=${PAPER_FIELDS}`, apiKey);
	if (!paper?.paperId) return null;
	return normalizePaper(id, paper);
}

export async function stagePaperEnrichmentAttempt(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: PaperEnrichmentCandidate,
	stepName = 'enrich-paper-metadata',
): Promise<PaperEnrichmentAttempt> {
	const url = candidate.url?.trim();
	const paperId = detectPaperId(url);
	if (!url || !paperId) return { metadata: null, outcome: 'not_applicable' };
	const hasExistingAcademic = candidate.hasExistingAcademic ?? !!candidate.platform_metadata?.enrichments?.academic;
	const attemptStartedAt = Date.now();

	try {
		const metadata = await step.do(
			stepName,
			{ retries: { limit: 5, delay: paperEnrichmentRetryDelay }, timeout: '30 seconds' },
			async () => {
				const startedAt = Date.now();
				const paper = await enrichS2FromId(paperId, env.S2_API_KEY);
				console.info({
					tag: 'S2',
					event: 'academic_enrichment',
					resource_id: candidate.id,
					identity_kind: paperId.kind,
					outcome: paper ? 'resolved' : hasExistingAcademic ? 'preserved' : 'not_found',
					references_loaded: paper?.references.length ?? 0,
					latency_ms: Date.now() - startedAt,
				});
				return paper;
			},
		);
		return {
			metadata,
			outcome: metadata ? 'resolved' : hasExistingAcademic ? 'preserved' : 'not_found',
		};
	} catch (error) {
		console.warn({
			tag: 'S2',
			event: 'academic_enrichment',
			resource_id: candidate.id,
			identity_kind: paperId.kind,
			outcome: hasExistingAcademic ? 'preserved' : 'failed',
			references_loaded: 0,
			latency_ms: Date.now() - attemptStartedAt,
			error: error instanceof Error ? error.message : String(error),
		});
		return { metadata: null, outcome: hasExistingAcademic ? 'preserved' : 'failed' };
	}
}

export async function stagePaperEnrichment(
	env: CoreEnv,
	step: WorkflowStep,
	candidate: Pick<ResourceForProcessing, 'id' | 'platform_metadata' | 'url'>,
): Promise<PaperMetadata | null> {
	return (await stagePaperEnrichmentAttempt(env, step, candidate)).metadata;
}
