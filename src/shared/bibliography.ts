/**
 * Provider-independent bibliography contracts shared by Core and the app.
 *
 * `Resource.kind` remains the product presentation axis. These types describe
 * citation semantics only and deliberately contain no provider or Zotero sync
 * identity.
 */

export const SUPPORTED_CSL_TYPES = [
	'article',
	'article-journal',
	'article-newspaper',
	'book',
	'chapter',
	'dataset',
	'graphic',
	'motion_picture',
	'paper-conference',
	'post',
	'post-weblog',
	'review',
	'thesis',
	'webpage',
] as const;

export type SupportedCslType = (typeof SUPPORTED_CSL_TYPES)[number];

export const RESOURCE_CREATOR_ROLES = [
	'author',
	'editor',
	'translator',
	'contributor',
	'creator',
	'director',
	'producer',
	'host',
	'guest',
	'artist',
] as const;

export type ResourceCreatorRole = (typeof RESOURCE_CREATOR_ROLES)[number];

export type BibliographicDatePart = readonly [number] | readonly [number, number] | readonly [number, number, number];

export type BibliographicDate =
	| Readonly<{
			'date-parts': readonly [BibliographicDatePart] | readonly [BibliographicDatePart, BibliographicDatePart];
	  }>
	| Readonly<{ literal: string }>;

export type BibliographicExtraValue = string | number | boolean | null;

export type BibliographicMetadata = Readonly<{
	cslType: SupportedCslType;
	abstractText?: string;
	containerTitle?: string;
	publisher?: string;
	publisherPlace?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	edition?: string;
	issued?: BibliographicDate;
	doi?: string;
	arxivId?: string;
	isbn?: string;
	issn?: string;
	pmid?: string;
	archive?: string;
	archiveLocation?: string;
	rights?: string;
	extra?: Readonly<Record<string, BibliographicExtraValue>>;
}>;

type ResourceCreatorBase = Readonly<{
	role: ResourceCreatorRole;
	orderIndex: number;
	orcid?: string;
}>;

export type ResourcePersonCreator = ResourceCreatorBase &
	Readonly<{
		firstName?: string;
		lastName?: string;
		name?: never;
	}>;

export type ResourceLiteralCreator = ResourceCreatorBase &
	Readonly<{
		name: string;
		firstName?: never;
		lastName?: never;
	}>;

export type ResourceCreator = ResourcePersonCreator | ResourceLiteralCreator;

export type ResourceBibliography = Readonly<{
	metadata: BibliographicMetadata;
	creators: readonly ResourceCreator[];
}>;

export const SEMANTIC_SCHOLAR_PUBLICATION_TYPES = [
	'Review',
	'JournalArticle',
	'CaseReport',
	'ClinicalTrial',
	'Conference',
	'Dataset',
	'Editorial',
	'LettersAndComments',
	'MetaAnalysis',
	'News',
	'Study',
	'Book',
	'BookSection',
] as const;

export type SemanticScholarPublicationType = (typeof SEMANTIC_SCHOLAR_PUBLICATION_TYPES)[number];

export const SEMANTIC_SCHOLAR_CSL_TYPE = {
	Review: 'review',
	JournalArticle: 'article-journal',
	CaseReport: 'article-journal',
	ClinicalTrial: 'article-journal',
	Conference: 'paper-conference',
	Dataset: 'dataset',
	Editorial: 'article-journal',
	LettersAndComments: 'article-journal',
	MetaAnalysis: 'article-journal',
	News: 'article-newspaper',
	Study: 'article-journal',
	Book: 'book',
	BookSection: 'chapter',
} as const satisfies Readonly<Record<SemanticScholarPublicationType, SupportedCslType>>;

export type SemanticScholarBibliographySource = Readonly<{
	doi?: string | null;
	arxivId?: string | null;
	abstract?: string | null;
	venue?: string | null;
	year?: number | null;
	publicationDate?: string | null;
	publicationTypes?: readonly string[] | null;
	authors?: readonly string[] | null;
}>;

export type CslJsonName = Readonly<{
	family?: string;
	given?: string;
	literal?: string;
}>;

type CslCreatorFields = Readonly<{
	author?: readonly CslJsonName[];
	editor?: readonly CslJsonName[];
	translator?: readonly CslJsonName[];
	contributor?: readonly CslJsonName[];
	director?: readonly CslJsonName[];
	producer?: readonly CslJsonName[];
	host?: readonly CslJsonName[];
	guest?: readonly CslJsonName[];
}>;

type CslBibliographicFields = Readonly<{
	abstract?: string;
	'container-title'?: string;
	publisher?: string;
	'publisher-place'?: string;
	volume?: string;
	issue?: string;
	page?: string;
	edition?: string;
	issued?: BibliographicDate;
	DOI?: string;
	ISBN?: string;
	ISSN?: string;
	PMID?: string;
	archive?: string;
	archive_location?: string;
	URL?: string;
	custom?: Readonly<Record<string, BibliographicExtraValue>>;
}>;

export type CslJsonItem = CslCreatorFields &
	CslBibliographicFields &
	Readonly<{
		id: string;
		type: SupportedCslType;
		title: string;
	}>;

const DOI_RE = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i;
const MODERN_ARXIV_ID_RE = /^(\d{4}\.\d{4,5})(?:v\d+)?$/i;
const LEGACY_ARXIV_ID_RE = /^([a-z][a-z0-9.-]*\/[0-9]{7})(?:v\d+)?$/i;
const ISO_PARTIAL_DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const ISO_LIKE_RE = /^\d{4}(?:-|$)/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
	return nonEmptyString(value) ?? undefined;
}

function isResourceCreatorRole(value: unknown): value is ResourceCreatorRole {
	return typeof value === 'string' && (RESOURCE_CREATOR_ROLES as readonly string[]).includes(value);
}

function stripDoiPrefix(value: string): string {
	return value
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
		.replace(/^doi\s*:\s*/i, '')
		.trim();
}

function stripUnbalancedDoiPunctuation(value: string): string {
	let doi = value.replace(/[.,;]+$/, '');
	const count = (character: string) => [...doi].filter((item) => item === character).length;
	while (doi.endsWith(')') && count(')') > count('(')) doi = doi.slice(0, -1);
	while (doi.endsWith(']') && count(']') > count('[')) doi = doi.slice(0, -1);
	return doi;
}

export function normalizeDoi(value: unknown): string | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		// A malformed escape cannot become a valid DOI after normalization.
	}
	const doi = stripUnbalancedDoiPunctuation(stripDoiPrefix(decoded)).toLowerCase();
	if (/n{4,}|x{4,}/i.test(doi)) return null;
	return DOI_RE.test(doi) ? doi : null;
}

function arxivIdFromUrl(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.hostname.toLowerCase() !== 'arxiv.org' && !url.hostname.toLowerCase().endsWith('.arxiv.org')) return null;
	const match = url.pathname.match(/^\/(?:abs|html|pdf)\/(.+?)(?:\.pdf)?\/?$/i);
	return match?.[1] ?? null;
}

export function normalizeArxivId(value: unknown): string | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	const candidate = (arxivIdFromUrl(raw) ?? raw.replace(/^arxiv\s*:\s*/i, ''))
		.replace(/[?#].*$/, '')
		.replace(/\.pdf$/i, '')
		.trim();
	const modern = candidate.match(MODERN_ARXIV_ID_RE)?.[1];
	if (modern) {
		const month = Number(modern.slice(2, 4));
		return month >= 1 && month <= 12 ? modern : null;
	}
	const legacy = candidate.match(LEGACY_ARXIV_ID_RE)?.[1];
	return legacy?.toLowerCase() ?? null;
}

function isValidDatePart(part: readonly number[]): part is BibliographicDatePart {
	if (part.length < 1 || part.length > 3 || !part.every(Number.isInteger)) return false;
	const [year, month, day] = part;
	if (year === undefined || year < 1 || year > 9999) return false;
	if (month === undefined) return true;
	if (month < 1 || month > 12) return false;
	if (day === undefined) return true;
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function datePartsFromString(value: string): BibliographicDatePart | null {
	const match = value.match(ISO_PARTIAL_DATE_RE);
	if (!match) return null;
	const part = [Number(match[1]), ...(match[2] ? [Number(match[2])] : []), ...(match[3] ? [Number(match[3])] : [])];
	return isValidDatePart(part) ? part : null;
}

function datePartsFromUnknown(value: unknown): BibliographicDatePart | null {
	if (!Array.isArray(value)) return null;
	const parts = value.map((part) => (typeof part === 'string' && /^\d+$/.test(part) ? Number(part) : part));
	return parts.every((part): part is number => typeof part === 'number') && isValidDatePart(parts) ? parts : null;
}

function structuredBibliographicDate(value: Record<string, unknown>): BibliographicDate | null {
	const literal = nonEmptyString(value.literal);
	const rawDateParts = value['date-parts'];
	if (literal && rawDateParts !== undefined) return null;
	if (literal) return { literal };
	if (!Array.isArray(rawDateParts) || rawDateParts.length < 1 || rawDateParts.length > 2) return null;
	const dateParts = rawDateParts.map(datePartsFromUnknown);
	if (dateParts.some((part) => part === null)) return null;
	return { 'date-parts': dateParts as [BibliographicDatePart] | [BibliographicDatePart, BibliographicDatePart] };
}

export function normalizeBibliographicDate(value: unknown): BibliographicDate | null {
	if (typeof value === 'number') {
		return isValidDatePart([value]) ? { 'date-parts': [[value]] } : null;
	}
	const text = nonEmptyString(value);
	if (text) {
		const dateParts = datePartsFromString(text);
		if (dateParts) return { 'date-parts': [dateParts] };
		return ISO_LIKE_RE.test(text) ? null : { literal: text };
	}
	return isRecord(value) ? structuredBibliographicDate(value) : null;
}

function normalizeOrcid(value: unknown): string | null {
	const raw = nonEmptyString(value);
	if (!raw) return null;
	const compact = raw
		.replace(/^https?:\/\/orcid\.org\//i, '')
		.replace(/-/g, '')
		.toUpperCase();
	if (!/^\d{15}[\dX]$/.test(compact)) return null;
	let total = 0;
	for (const digit of compact.slice(0, 15)) total = (total + Number(digit)) * 2;
	const result = (12 - (total % 11)) % 11;
	const expected = result === 10 ? 'X' : String(result);
	if (compact.at(-1) !== expected) return null;
	return compact.replace(/(.{4})(?=.)/g, '$1-');
}

export function normalizeResourceCreator(value: unknown): ResourceCreator | null {
	if (!isRecord(value) || !isResourceCreatorRole(value.role)) return null;
	if (!Number.isInteger(value.orderIndex) || (value.orderIndex as number) < 0) return null;
	const name = optionalString(value.name);
	const firstName = optionalString(value.firstName);
	const lastName = optionalString(value.lastName);
	if (name ? firstName || lastName : !firstName && !lastName) return null;
	const rawOrcid = nonEmptyString(value.orcid);
	const orcid = rawOrcid ? normalizeOrcid(rawOrcid) : null;
	if (rawOrcid && !orcid) return null;
	const base = {
		role: value.role,
		orderIndex: value.orderIndex as number,
		...(orcid ? { orcid } : {}),
	};
	return name
		? { ...base, name }
		: {
				...base,
				...(firstName ? { firstName } : {}),
				...(lastName ? { lastName } : {}),
			};
}

export function normalizeResourceCreators(value: unknown): ResourceCreator[] | null {
	if (!Array.isArray(value)) return null;
	const creators = value.map(normalizeResourceCreator);
	if (creators.some((creator) => creator === null)) return null;
	const normalized = creators as ResourceCreator[];
	const orderIndexes = new Set(normalized.map((creator) => creator.orderIndex));
	if (orderIndexes.size !== normalized.length) return null;
	return normalized.sort((left, right) => left.orderIndex - right.orderIndex);
}

function normalizedSemanticScholarType(value: string): SemanticScholarPublicationType | null {
	const comparable = value.replace(/[^a-z]/gi, '').toLowerCase();
	return SEMANTIC_SCHOLAR_PUBLICATION_TYPES.find((type) => type.toLowerCase() === comparable) ?? null;
}

const SEMANTIC_SCHOLAR_TYPE_PRIORITY = [
	'Conference',
	'BookSection',
	'Book',
	'Dataset',
	'News',
	'JournalArticle',
	'CaseReport',
	'ClinicalTrial',
	'Editorial',
	'LettersAndComments',
	'MetaAnalysis',
	'Study',
	'Review',
] as const satisfies readonly SemanticScholarPublicationType[];

export function semanticScholarCslType(publicationTypes: readonly string[] | null | undefined): SupportedCslType {
	const normalized = new Set((publicationTypes ?? []).flatMap((value) => normalizedSemanticScholarType(value) ?? []));
	const selected = SEMANTIC_SCHOLAR_TYPE_PRIORITY.find((type) => normalized.has(type));
	return selected ? SEMANTIC_SCHOLAR_CSL_TYPE[selected] : 'article';
}

function semanticScholarIssuedDate(source: SemanticScholarBibliographySource): BibliographicDate | undefined {
	const publicationDate = nonEmptyString(source.publicationDate);
	if (publicationDate && ISO_PARTIAL_DATE_RE.test(publicationDate)) {
		const normalized = normalizeBibliographicDate(publicationDate);
		if (normalized) return normalized;
	}
	return source.year === undefined || source.year === null ? undefined : (normalizeBibliographicDate(source.year) ?? undefined);
}

export function bibliographyFromSemanticScholar(source: SemanticScholarBibliographySource): ResourceBibliography {
	const abstractText = optionalString(source.abstract);
	const containerTitle = optionalString(source.venue);
	const issued = semanticScholarIssuedDate(source);
	const doi = normalizeDoi(source.doi) ?? undefined;
	const arxivId = normalizeArxivId(source.arxivId) ?? undefined;
	const authors = (source.authors ?? []).flatMap((author) => optionalString(author) ?? []);
	return {
		metadata: {
			cslType: semanticScholarCslType(source.publicationTypes),
			...(abstractText ? { abstractText } : {}),
			...(containerTitle ? { containerTitle } : {}),
			...(issued ? { issued } : {}),
			...(doi ? { doi } : {}),
			...(arxivId ? { arxivId } : {}),
		},
		// S2 exposes a single display name. Preserve it as a CSL literal instead
		// of inventing an unreliable given/family split.
		creators: authors.map((name, orderIndex) => ({ name, orderIndex, role: 'author' })),
	};
}

function cslName(creator: ResourceCreator): CslJsonName {
	if ('name' in creator) return { literal: creator.name };
	return {
		...(creator.lastName ? { family: creator.lastName } : {}),
		...(creator.firstName ? { given: creator.firstName } : {}),
	};
}

function cslNamesForRoles(creators: readonly ResourceCreator[], roles: readonly ResourceCreatorRole[]): CslJsonName[] | undefined {
	const names = creators
		.filter((creator) => roles.includes(creator.role))
		.sort((left, right) => left.orderIndex - right.orderIndex)
		.map(cslName);
	return names.length > 0 ? names : undefined;
}

function cslCustomFields(metadata: BibliographicMetadata): Readonly<Record<string, BibliographicExtraValue>> | undefined {
	const custom = {
		...(metadata.extra ?? {}),
		...(metadata.rights ? { rights: metadata.rights } : {}),
	};
	return Object.keys(custom).length > 0 ? custom : undefined;
}

function cslCreatorFields(creators: readonly ResourceCreator[]): CslCreatorFields {
	const author = cslNamesForRoles(creators, ['author', 'creator', 'artist']);
	const editor = cslNamesForRoles(creators, ['editor']);
	const translator = cslNamesForRoles(creators, ['translator']);
	const contributor = cslNamesForRoles(creators, ['contributor']);
	const director = cslNamesForRoles(creators, ['director']);
	const producer = cslNamesForRoles(creators, ['producer']);
	const host = cslNamesForRoles(creators, ['host']);
	const guest = cslNamesForRoles(creators, ['guest']);
	return {
		...(author ? { author } : {}),
		...(editor ? { editor } : {}),
		...(translator ? { translator } : {}),
		...(contributor ? { contributor } : {}),
		...(director ? { director } : {}),
		...(producer ? { producer } : {}),
		...(host ? { host } : {}),
		...(guest ? { guest } : {}),
	};
}

function cslBibliographicFields(metadata: BibliographicMetadata, url: string | null | undefined): CslBibliographicFields {
	const archive = metadata.archive ?? (metadata.arxivId ? 'arXiv' : undefined);
	const archiveLocation = metadata.archiveLocation ?? metadata.arxivId;
	const custom = cslCustomFields(metadata);
	return {
		...(metadata.abstractText ? { abstract: metadata.abstractText } : {}),
		...(metadata.containerTitle ? { 'container-title': metadata.containerTitle } : {}),
		...(metadata.publisher ? { publisher: metadata.publisher } : {}),
		...(metadata.publisherPlace ? { 'publisher-place': metadata.publisherPlace } : {}),
		...(metadata.volume ? { volume: metadata.volume } : {}),
		...(metadata.issue ? { issue: metadata.issue } : {}),
		...(metadata.pages ? { page: metadata.pages } : {}),
		...(metadata.edition ? { edition: metadata.edition } : {}),
		...(metadata.issued ? { issued: metadata.issued } : {}),
		...(metadata.doi ? { DOI: metadata.doi } : {}),
		...(metadata.isbn ? { ISBN: metadata.isbn } : {}),
		...(metadata.issn ? { ISSN: metadata.issn } : {}),
		...(metadata.pmid ? { PMID: metadata.pmid } : {}),
		...(archive ? { archive } : {}),
		...(archiveLocation ? { archive_location: archiveLocation } : {}),
		...(url ? { URL: url } : {}),
		...(custom ? { custom } : {}),
	};
}

export function resourceBibliographyToCsl(
	input: Readonly<{
		id: string;
		title: string;
		url?: string | null;
		metadata: BibliographicMetadata;
		creators: readonly ResourceCreator[];
	}>,
): CslJsonItem {
	const { metadata } = input;
	return {
		id: input.id,
		type: metadata.cslType,
		title: input.title,
		...cslBibliographicFields(metadata, input.url),
		...cslCreatorFields(input.creators),
	};
}
