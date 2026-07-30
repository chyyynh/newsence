export const RESOURCE_KINDS = ['blog', 'forum', 'post', 'video', 'paper', 'image', 'file'] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const CONTENT_RESOURCE_KINDS = ['blog', 'forum', 'post', 'video', 'paper'] as const satisfies readonly ResourceKind[];

export type ContentResourceKind = (typeof CONTENT_RESOURCE_KINDS)[number];

export const TRANSLATABLE_RESOURCE_KINDS = ['blog', 'forum', 'post', 'paper'] as const satisfies readonly ResourceKind[];

export const RESOURCE_PLATFORMS = ['hackernews', 'twitter', 'youtube'] as const;

export type ResourcePlatform = (typeof RESOURCE_PLATFORMS)[number] | null;

export const VALID_KIND_PLATFORMS = {
	blog: [null],
	forum: ['hackernews'],
	post: ['twitter'],
	video: ['youtube'],
	paper: [null, 'hackernews'],
	image: [null],
	file: [null],
} as const satisfies Readonly<Record<ResourceKind, readonly ResourcePlatform[]>>;

export type ResourceIdentity = {
	[K in ResourceKind]: Readonly<{
		kind: K;
		resourcePlatform: (typeof VALID_KIND_PLATFORMS)[K][number];
	}>;
}[ResourceKind];

/** Canonical resource identity using the database/workflow column names. */
export type ResourceIdentityColumns = {
	[K in ResourceKind]: Readonly<{
		kind: K;
		resource_platform: (typeof VALID_KIND_PLATFORMS)[K][number];
	}>;
}[ResourceKind];

export type ContentResourceIdentity = Extract<ResourceIdentity, { kind: ContentResourceKind }>;

export function toResourceIdentityColumns(identity: ResourceIdentity): ResourceIdentityColumns {
	switch (identity.kind) {
		case 'blog':
			return { kind: identity.kind, resource_platform: identity.resourcePlatform };
		case 'forum':
			return { kind: identity.kind, resource_platform: identity.resourcePlatform };
		case 'post':
			return { kind: identity.kind, resource_platform: identity.resourcePlatform };
		case 'video':
			return { kind: identity.kind, resource_platform: identity.resourcePlatform };
		case 'paper':
			return { kind: identity.kind, resource_platform: identity.resourcePlatform };
		case 'image':
			return { kind: identity.kind, resource_platform: identity.resourcePlatform };
		case 'file':
			return { kind: identity.kind, resource_platform: identity.resourcePlatform };
	}
}

export type ResourceIdentityFilters = Readonly<{
	kinds?: readonly ResourceKind[];
	resourcePlatforms?: readonly ResourcePlatform[];
}>;

const DETECTED_PLATFORM_RESOURCE_IDENTITIES = {
	hackernews: { kind: 'forum', resourcePlatform: 'hackernews' },
	twitter: { kind: 'post', resourcePlatform: 'twitter' },
	youtube: { kind: 'video', resourcePlatform: 'youtube' },
} as const satisfies Readonly<Record<Exclude<ResourcePlatform, null>, ContentResourceIdentity>>;

export const RESOURCE_KIND_DISPLAY_LABELS = {
	blog: 'Blog',
	forum: 'Forum',
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

function isResourceKind(value: unknown): value is ResourceKind {
	return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

export function isContentResourceKind(value: unknown): value is ContentResourceKind {
	return typeof value === 'string' && (CONTENT_RESOURCE_KINDS as readonly string[]).includes(value);
}

export function isResourcePlatform(value: unknown): value is ResourcePlatform {
	return value === null || (typeof value === 'string' && (RESOURCE_PLATFORMS as readonly string[]).includes(value));
}

export function isResourceIdentity(identity: { kind: unknown; resourcePlatform: unknown }): identity is ResourceIdentity {
	if (!isResourceKind(identity.kind) || !isResourcePlatform(identity.resourcePlatform)) return false;
	const validPlatforms: readonly ResourcePlatform[] = VALID_KIND_PLATFORMS[identity.kind];
	return validPlatforms.includes(identity.resourcePlatform);
}

export function isValidKindPlatform(kind: unknown, resourcePlatform: unknown): kind is ResourceKind {
	return isResourceIdentity({ kind, resourcePlatform });
}

export function parseResourceIdentity(kind: unknown, resourcePlatform: unknown): ResourceIdentity | null {
	const identity = { kind, resourcePlatform };
	return isResourceIdentity(identity) ? identity : null;
}

export function isContentResourceIdentity(identity: ResourceIdentity): identity is ContentResourceIdentity {
	return isContentResourceKind(identity.kind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function needsResourcePlatformAcquisition(input: { platformData: unknown; resourcePlatform: ResourcePlatform }): boolean {
	return input.resourcePlatform !== null && !isRecord(input.platformData);
}

function resourceSourceSnapshotHash(platformMetadata: unknown): string | null {
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

export function resourceIdentityForDetectedPlatform(
	resourcePlatform: Exclude<ResourcePlatform, null>,
	hasAcademicEnrichment = false,
): ContentResourceIdentity {
	return resourceIdentityWithAcademic(DETECTED_PLATFORM_RESOURCE_IDENTITIES[resourcePlatform], hasAcademicEnrichment);
}

export function resourceIdentityWithAcademic(identity: ContentResourceIdentity, hasAcademicEnrichment: boolean): ContentResourceIdentity;
export function resourceIdentityWithAcademic(identity: ResourceIdentity, hasAcademicEnrichment: boolean): ResourceIdentity;
export function resourceIdentityWithAcademic(identity: ResourceIdentity, hasAcademicEnrichment: boolean): ResourceIdentity {
	if (!hasAcademicEnrichment || (identity.kind !== 'blog' && identity.kind !== 'forum')) return identity;
	return { kind: 'paper', resourcePlatform: identity.resourcePlatform };
}

export function isResourceTranslationIdentityEligible(input: {
	kind: unknown;
	resourcePlatform: unknown;
	fileType: string | null | undefined;
}): boolean {
	const identity = parseResourceIdentity(input.kind, input.resourcePlatform);
	if (!identity || !(TRANSLATABLE_RESOURCE_KINDS as readonly ResourceKind[]).includes(identity.kind)) return false;
	return !(input.fileType === 'application/pdf' && identity.resourcePlatform === null);
}

export const SOURCE_PLATFORMS = ['rss', 'twitter', 'youtube'] as const;

export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export function isSourcePlatform(value: unknown): value is SourcePlatform {
	return typeof value === 'string' && (SOURCE_PLATFORMS as readonly string[]).includes(value);
}

// Editorial kind of an article-family source. Distinguishes reader-facing Blog
// vs News independently from the canonical resource identity. Only meaningful
// for rss/web sources.
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
