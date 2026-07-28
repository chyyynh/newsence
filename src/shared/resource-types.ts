export const CONTENT_RESOURCE_TYPES = ['web', 'rss', 'twitter', 'youtube', 'hackernews', 'pdf'] as const;

export type ContentResourceType = (typeof CONTENT_RESOURCE_TYPES)[number];

const MEDIA_RESOURCE_TYPES = ['image', 'file'] as const;

export const RESOURCE_TYPES = [...CONTENT_RESOURCE_TYPES, ...MEDIA_RESOURCE_TYPES] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export function isContentResourceType(value: unknown): value is ContentResourceType {
	return typeof value === 'string' && (CONTENT_RESOURCE_TYPES as readonly string[]).includes(value);
}

export function isResourceType(value: unknown): value is ResourceType {
	return typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);
}

export function legacyResourceTypeAfterAcquisition(current: ContentResourceType, acquired: ContentResourceType): ContentResourceType {
	return current === 'rss' && acquired === 'web' ? 'rss' : acquired;
}

export const RESOURCE_KINDS = ['document', 'post', 'video', 'paper', 'image', 'file'] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const CONTENT_RESOURCE_KINDS = ['document', 'post', 'video', 'paper'] as const satisfies readonly ResourceKind[];

export type ContentResourceKind = (typeof CONTENT_RESOURCE_KINDS)[number];

export const TRANSLATABLE_RESOURCE_KINDS = ['document', 'post', 'paper'] as const satisfies readonly ResourceKind[];

export const RESOURCE_PLATFORMS = ['hackernews', 'twitter', 'youtube'] as const;

export type ResourcePlatform = (typeof RESOURCE_PLATFORMS)[number] | null;

export const VALID_KIND_PLATFORMS = {
	document: [null, 'hackernews'],
	post: ['twitter'],
	video: ['youtube'],
	paper: [null, 'hackernews'],
	image: [null],
	file: [null],
} as const satisfies Readonly<Record<ResourceKind, readonly ResourcePlatform[]>>;

export type ResourceIdentity = Readonly<{
	kind: ResourceKind;
	resourcePlatform: ResourcePlatform;
}>;

export const LEGACY_RESOURCE_IDENTITIES = {
	web: { kind: 'document', resourcePlatform: null },
	rss: { kind: 'document', resourcePlatform: null },
	twitter: { kind: 'post', resourcePlatform: 'twitter' },
	youtube: { kind: 'video', resourcePlatform: 'youtube' },
	hackernews: { kind: 'document', resourcePlatform: 'hackernews' },
	pdf: { kind: 'document', resourcePlatform: null },
	image: { kind: 'image', resourcePlatform: null },
	file: { kind: 'file', resourcePlatform: null },
} as const satisfies Readonly<Record<ResourceType, ResourceIdentity>>;

export const RESOURCE_KIND_DISPLAY_LABELS = {
	document: 'Document',
	post: 'Post',
	video: 'Video',
	paper: 'Paper',
	image: 'Image',
	file: 'File',
} as const satisfies Readonly<Record<ResourceKind, string>>;

export const RESOURCE_PLATFORM_DISPLAY_LABELS = {
	hackernews: 'Hacker News',
	twitter: 'Twitter',
	youtube: 'YouTube',
} as const satisfies Readonly<Record<Exclude<ResourcePlatform, null>, string>>;

export function resourceIdentityDisplayLabel(identity: ResourceIdentity): string {
	return identity.resourcePlatform
		? RESOURCE_PLATFORM_DISPLAY_LABELS[identity.resourcePlatform]
		: RESOURCE_KIND_DISPLAY_LABELS[identity.kind];
}

export function isResourceKind(value: unknown): value is ResourceKind {
	return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

export function isContentResourceKind(value: unknown): value is ContentResourceKind {
	return typeof value === 'string' && (CONTENT_RESOURCE_KINDS as readonly string[]).includes(value);
}

export function isResourcePlatform(value: unknown): value is ResourcePlatform {
	return value === null || (typeof value === 'string' && (RESOURCE_PLATFORMS as readonly string[]).includes(value));
}

export function isValidKindPlatform(kind: unknown, resourcePlatform: unknown): kind is ResourceKind {
	if (!isResourceKind(kind) || !isResourcePlatform(resourcePlatform)) return false;
	return (VALID_KIND_PLATFORMS[kind] as readonly ResourcePlatform[]).includes(resourcePlatform);
}

export function parseResourceIdentity(kind: unknown, resourcePlatform: unknown): ResourceIdentity | null {
	if (!isValidKindPlatform(kind, resourcePlatform)) return null;
	return { kind, resourcePlatform: resourcePlatform as ResourcePlatform };
}

export function assertValidKindPlatform(kind: unknown, resourcePlatform: unknown): asserts kind is ResourceKind {
	if (!isValidKindPlatform(kind, resourcePlatform)) {
		throw new Error(`Invalid resource kind/platform pair: ${String(kind)} / ${String(resourcePlatform)}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function needsResourcePlatformAcquisition(input: {
	platformData: unknown;
	resourcePlatform: ResourcePlatform;
	type: ResourceType;
}): boolean {
	return input.resourcePlatform !== null && (input.type !== input.resourcePlatform || !isRecord(input.platformData));
}

export function resourceSourceSnapshotHash(platformMetadata: unknown): string | null {
	if (!isRecord(platformMetadata) || typeof platformMetadata.sourceSnapshotHash !== 'string') return null;
	return platformMetadata.sourceSnapshotHash.trim() || null;
}

function resourceSourceFetchedAt(platformMetadata: unknown): number | null {
	if (!isRecord(platformMetadata) || typeof platformMetadata.fetchedAt !== 'string') return null;
	const fetchedAt = Date.parse(platformMetadata.fetchedAt);
	return Number.isNaN(fetchedAt) ? null : fetchedAt;
}

export function isIncomingResourceSnapshotSuperseded(incoming: unknown, stored: unknown): boolean {
	const incomingHash = resourceSourceSnapshotHash(incoming);
	const storedHash = resourceSourceSnapshotHash(stored);
	if (!storedHash) return false;
	if (!incomingHash) return true;
	const incomingFetchedAt = resourceSourceFetchedAt(incoming);
	const storedFetchedAt = resourceSourceFetchedAt(stored);
	if (storedHash === incomingHash) {
		return incomingFetchedAt !== null && storedFetchedAt !== null && storedFetchedAt > incomingFetchedAt;
	}
	if (incomingFetchedAt === null || storedFetchedAt === null) return true;
	return storedFetchedAt >= incomingFetchedAt;
}

export function hasSemanticScholarAcademicEnrichment(platformMetadata: unknown): boolean {
	if (!isRecord(platformMetadata) || !isRecord(platformMetadata.enrichments)) return false;
	const academic = platformMetadata.enrichments.academic;
	return isRecord(academic) && academic.source === 'semanticscholar';
}

export function legacyResourceIdentity(type: ResourceType, hasAcademicEnrichment = false): ResourceIdentity {
	const identity = LEGACY_RESOURCE_IDENTITIES[type];
	return resourceIdentityWithAcademic(identity, hasAcademicEnrichment);
}

export function resourceIdentityForDetectedPlatform(
	resourcePlatform: Exclude<ResourcePlatform, null>,
	hasAcademicEnrichment = false,
): ResourceIdentity {
	return legacyResourceIdentity(resourcePlatform, hasAcademicEnrichment);
}

export function resourceIdentityWithAcademic(identity: ResourceIdentity, hasAcademicEnrichment: boolean): ResourceIdentity {
	if (!hasAcademicEnrichment || identity.kind !== 'document') return identity;
	return { kind: 'paper', resourcePlatform: identity.resourcePlatform };
}

export function isResourceTranslationIdentityEligible(input: {
	kind: unknown;
	resourcePlatform: unknown;
	fileType: string | null | undefined;
}): boolean {
	if (!isValidKindPlatform(input.kind, input.resourcePlatform)) return false;
	if (!(TRANSLATABLE_RESOURCE_KINDS as readonly ResourceKind[]).includes(input.kind)) return false;
	return !(input.fileType === 'application/pdf' && input.resourcePlatform === null);
}

// Translation/enrichment completeness policy for legacy resource rows. Keep
// this policy domain independent from the umbrella ContentResourceType alias
// so the overloaded resource-type contract can be retired in stages (#245).
export const RESOURCE_ORIGINAL_CONTENT_TYPES = ['web', 'rss', 'twitter', 'hackernews'] as const;

export const SOURCE_PLATFORMS = ['rss', 'twitter', 'youtube'] as const;

export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export function isSourcePlatform(value: unknown): value is SourcePlatform {
	return typeof value === 'string' && (SOURCE_PLATFORMS as readonly string[]).includes(value);
}

// Editorial kind of an article-family source. Distinguishes reader-facing Blog
// vs News, which resources.type (web/rss) can't express since both come from the
// same ingest kinds. Only meaningful for rss/web sources.
export const SOURCE_KINDS = ['blog', 'news'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export function isSourceKind(value: unknown): value is SourceKind {
	return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

export const SOURCE_ACQUISITION_MODES = ['platform', 'web', 'feed'] as const;

export type SourceAcquisitionMode = (typeof SOURCE_ACQUISITION_MODES)[number];

// Add-source validation lifecycle for user-added sources (#237); failure
// details live in scrape_state.
export const SOURCE_STATUSES = ['pending', 'active', 'failed'] as const;

export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const RESOURCE_SCOPES = ['corpus', 'private'] as const;

export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export type ResourceContentSurface = 'app' | 'ai-tools' | 'export';

export function hasResourceContentAccess(input: { surface: ResourceContentSurface; scope: string; viewerHasOwnership: boolean }): boolean {
	// AI and exports stay ownership-gated so stored or paywalled corpus content
	// is not redistributed by default.
	return (input.scope === 'corpus' && input.surface === 'app') || input.viewerHasOwnership;
}

export const DEFAULT_RESOURCE_LANG = 'en';

export const ZH_HANT_RESOURCE_LANG = 'zh-Hant';

const RESOURCE_LANG_MAX_LENGTH = 35;

export function canonicalizeResourceLang(value: unknown): string {
	if (typeof value !== 'string') throw new Error(`Invalid resource language: ${String(value)}`);
	const lang = value.trim();
	if (!lang || lang.length > RESOURCE_LANG_MAX_LENGTH) throw new Error(`Invalid resource language: ${value}`);

	try {
		const canonical = Intl.getCanonicalLocales(lang)[0];
		if (!canonical || canonical.length > RESOURCE_LANG_MAX_LENGTH) throw new Error('Invalid locale');
		return canonical;
	} catch {
		throw new Error(`Invalid resource language: ${value}`);
	}
}

export function canonicalizeOptionalResourceLang(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const lang = value.trim().replaceAll('_', '-');
	if (!lang || lang.toLowerCase() === 'und') return null;
	try {
		return canonicalizeResourceLang(lang);
	} catch {
		return null;
	}
}

export function targetResourceLocale(requestedLocale: string | null | undefined, originalLang: string | null | undefined): string | null {
	return canonicalizeOptionalResourceLang(requestedLocale) ?? canonicalizeOptionalResourceLang(originalLang);
}

export function selectPreferredResourceTranslation<T extends { lang: string }>(
	translations: readonly T[],
	requestedLocale: string | null | undefined,
	originalLang: string | null | undefined,
): T | null {
	const byLocale = new Map<string, T>();
	for (const translation of translations) {
		const locale = canonicalizeOptionalResourceLang(translation.lang);
		if (locale && !byLocale.has(locale)) byLocale.set(locale, translation);
	}
	const requested = canonicalizeOptionalResourceLang(requestedLocale);
	const original = canonicalizeOptionalResourceLang(originalLang);
	return (requested ? byLocale.get(requested) : null) ?? (original ? byLocale.get(original) : null) ?? null;
}

export const RESOURCE_CATEGORIES = ['AI', 'Tech', 'Finance', 'Research', 'Business', 'Other'] as const;

export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const RESOURCE_TRANSLATION_SOURCES = ['original', 'machine', 'human'] as const;

export type ResourceTranslationSource = (typeof RESOURCE_TRANSLATION_SOURCES)[number];
