import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
	isResourceType,
	isValidKindPlatform,
	legacyResourceIdentity,
	RESOURCE_KINDS,
	RESOURCE_PLATFORMS,
	type ResourceIdentity,
	type ResourceKind,
	type ResourcePlatform,
	resourceIdentityForDetectedPlatform,
	VALID_KIND_PLATFORMS,
} from '@core-shared/resource-types';
import { detectResourcePlatform } from '@core-shared/url';
import { withCoreDb, withCoreTx } from '@db/client';
import type { QueryResultRow } from 'pg';
import { enqueueOrRestartWorkflow } from '../workflow-control';

const PAGE_SIZE = 500;
const MAX_PAGES = 1200;
const MAX_BLOCKING_AUDIT_GROUPS = 128;
const MAX_NONBLOCKING_AUDIT_GROUPS = 384;
const MAX_RESULT_AUDIT_GROUPS = 50;
const WORKFLOW_VERSION = 1;
const RESOURCE_IDENTITY_BACKFILL_MODES = ['dry-run', 'write', 'audit', 'convergence'] as const;

export type ResourceIdentityBackfillMode = (typeof RESOURCE_IDENTITY_BACKFILL_MODES)[number];

export type ResourceIdentityBackfillPayload = {
	mode?: ResourceIdentityBackfillMode;
};

const WORKFLOW_IDS = {
	'dry-run': `resource-identity-backfill-v${WORKFLOW_VERSION}-dry-run`,
	write: `resource-identity-backfill-v${WORKFLOW_VERSION}-write`,
	audit: `resource-identity-backfill-v${WORKFLOW_VERSION}-audit`,
	convergence: `resource-identity-backfill-v${WORKFLOW_VERSION}-convergence`,
} as const satisfies Record<ResourceIdentityBackfillMode, string>;

type ResourceIdentityBackfillRow = QueryResultRow & {
	id: string;
	legacy_type: string;
	enrichment_status: string;
	url: string | null;
	file_type: string | null;
	source_platform: string | null;
	has_academic_enrichment: boolean;
	has_platform_data: boolean;
	metadata_variant: string | null;
	metadata_external_url_matches_resource_url: boolean;
	kind: string | null;
	resource_platform: string | null;
};

type AuditDisposition = 'missing' | 'match' | 'conflict' | 'unmapped';

export type ResourceIdentityAuditGroup = {
	legacyType: string;
	enrichmentStatus: string;
	expectedKind: ResourceKind | null;
	expectedResourcePlatform: ResourcePlatform;
	fileType: string | null;
	sourcePlatform: string | null;
	hasAcademicEnrichment: boolean;
	hasPlatformData: boolean;
	metadataVariant: string | null;
	metadataExternalUrlMatchesResourceUrl: boolean;
	detectorPlatform: ResourcePlatform;
	currentKind: string | null;
	currentResourcePlatform: string | null;
	disposition: AuditDisposition;
	enrichedDetectorMismatch: boolean;
	blocking: boolean;
	count: number;
	sampleResourceIds: string[];
};

type AuditCounters = {
	scanned: number;
	missing: number;
	plannedWrites: number;
	matches: number;
	conflicts: number;
	unmapped: number;
	invalidCurrentIdentities: number;
	enrichedDetectorMismatches: number;
	blockingRows: number;
};

type AuditPage = {
	nextCursor: string | null;
	counters: AuditCounters;
	groups: ResourceIdentityAuditGroup[];
};

export type ResourceIdentityAudit = AuditCounters & {
	pages: number;
	groups: ResourceIdentityAuditGroup[];
	overflowGroups: number;
	overflowRows: number;
	overflowBlockingGroups: number;
	overflowBlockingRows: number;
	overflowBlockingSampleResourceIds: string[];
};

type WritePage = {
	nextCursor: string | null;
	scanned: number;
	planned: number;
	probed: number;
	changed: number;
	alreadyMatched: number;
};

type WriteSummary = {
	pages: number;
	scanned: number;
	planned: number;
	probed: number;
	changed: number;
	alreadyMatched: number;
};

export type ResourceIdentityInvariantCounters = {
	scanned: number;
	missingKind: number;
	platformWithoutKind: number;
	invalidKind: number;
	invalidPlatform: number;
	invalidKindPlatform: number;
};

export type ResourceIdentityBackfillSummary = {
	mode: ResourceIdentityBackfillMode;
	snapshotAt: string;
	before: ResourceIdentityAudit;
	write: WriteSummary;
	after: ResourceIdentityAudit;
	invariants: ResourceIdentityInvariantCounters;
};

type ResourceIdentityAuditResult = Omit<ResourceIdentityAudit, 'groups'> & {
	sampleGroups: ResourceIdentityAuditGroup[];
};

export type ResourceIdentityBackfillResult = {
	mode: ResourceIdentityBackfillMode;
	snapshotAt: string;
	before: ResourceIdentityAuditResult;
	write: WriteSummary;
	after: ResourceIdentityAuditResult;
	invariants: ResourceIdentityInvariantCounters;
};

type AuditedRow = {
	expected: ResourceIdentity | null;
	detectorPlatform: ResourcePlatform;
	disposition: AuditDisposition;
	currentIdentityValid: boolean;
	enrichedDetectorMismatch: boolean;
	blocking: boolean;
};

type AuditAccumulator = {
	counters: AuditCounters;
	blockingGroups: Map<string, ResourceIdentityAuditGroup>;
	nonBlockingGroups: Map<string, ResourceIdentityAuditGroup>;
	overflowGroups: number;
	overflowRows: number;
	overflowBlockingGroups: number;
	overflowBlockingRows: number;
	overflowBlockingSampleResourceIds: string[];
};

type ResourceIdentityWriteMode = Extract<ResourceIdentityBackfillMode, 'write' | 'convergence'>;

const DB_STEP_CONFIG = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
} as const;

function parseMode(value: unknown): ResourceIdentityBackfillMode {
	const mode = value ?? 'dry-run';
	if (typeof mode === 'string' && (RESOURCE_IDENTITY_BACKFILL_MODES as readonly string[]).includes(mode)) {
		return mode as ResourceIdentityBackfillMode;
	}
	throw new NonRetryableError(
		`Resource identity backfill mode must be one of: ${RESOURCE_IDENTITY_BACKFILL_MODES.join(', ')}`,
		'ResourceIdentityBackfillInputError',
	);
}

function emptyCounters(): AuditCounters {
	return {
		scanned: 0,
		missing: 0,
		plannedWrites: 0,
		matches: 0,
		conflicts: 0,
		unmapped: 0,
		invalidCurrentIdentities: 0,
		enrichedDetectorMismatches: 0,
		blockingRows: 0,
	};
}

function emptyAuditAccumulator(): AuditAccumulator {
	return {
		counters: emptyCounters(),
		blockingGroups: new Map(),
		nonBlockingGroups: new Map(),
		overflowGroups: 0,
		overflowRows: 0,
		overflowBlockingGroups: 0,
		overflowBlockingRows: 0,
		overflowBlockingSampleResourceIds: [],
	};
}

function emptyWriteSummary(): WriteSummary {
	return { pages: 0, scanned: 0, planned: 0, probed: 0, changed: 0, alreadyMatched: 0 };
}

function expectedIdentity(row: ResourceIdentityBackfillRow, detectorPlatform: ResourcePlatform): ResourceIdentity | null {
	if (!isResourceType(row.legacy_type)) return null;
	const legacyType = row.legacy_type;
	const hasAcademic = row.has_academic_enrichment;
	if (row.enrichment_status === 'enriched') return legacyResourceIdentity(legacyType, hasAcademic);
	if (detectorPlatform) return resourceIdentityForDetectedPlatform(detectorPlatform, hasAcademic);

	// Failed/pending platform drafts can carry a malformed or missing URL, so
	// their legacy special-platform type is not sufficient evidence. Generic
	// transport/file families remain deterministic after a negative detector.
	switch (legacyType) {
		case 'web':
		case 'rss':
		case 'pdf':
		case 'image':
		case 'file':
			return legacyResourceIdentity(legacyType, hasAcademic);
		case 'twitter':
		case 'youtube':
		case 'hackernews':
			return null;
		default:
			legacyType satisfies never;
			return null;
	}
}

function identitiesMatch(kind: string | null, resourcePlatform: string | null, expected: ResourceIdentity): boolean {
	return kind === expected.kind && resourcePlatform === expected.resourcePlatform;
}

function auditRow(row: ResourceIdentityBackfillRow): AuditedRow {
	const detectorPlatform = detectResourcePlatform(row.url);
	const expected = expectedIdentity(row, detectorPlatform);
	const identityMissing = row.kind === null && row.resource_platform === null;
	const currentIdentityValid = identityMissing || isValidKindPlatform(row.kind, row.resource_platform);
	const enrichedDetectorIdentity =
		row.enrichment_status === 'enriched' && detectorPlatform
			? resourceIdentityForDetectedPlatform(detectorPlatform, row.has_academic_enrichment)
			: null;
	const enrichedDetectorMismatch = !!(
		expected &&
		enrichedDetectorIdentity &&
		!identitiesMatch(enrichedDetectorIdentity.kind, enrichedDetectorIdentity.resourcePlatform, expected)
	);

	let disposition: AuditDisposition;
	if (!expected) disposition = 'unmapped';
	else if (identityMissing) disposition = 'missing';
	else if (identitiesMatch(row.kind, row.resource_platform, expected)) disposition = 'match';
	else disposition = 'conflict';

	const blocking = !expected || enrichedDetectorMismatch || (!identityMissing && (!currentIdentityValid || disposition === 'conflict'));
	return { expected, detectorPlatform, disposition, currentIdentityValid, enrichedDetectorMismatch, blocking };
}

function shortAuditValue(value: string | null): string | null {
	if (!value || value.length <= 96) return value;
	return `${value.slice(0, 95)}…`;
}

function auditGroup(row: ResourceIdentityBackfillRow, audited: AuditedRow): ResourceIdentityAuditGroup {
	return {
		legacyType: shortAuditValue(row.legacy_type) ?? '',
		enrichmentStatus: shortAuditValue(row.enrichment_status) ?? '',
		expectedKind: audited.expected?.kind ?? null,
		expectedResourcePlatform: audited.expected?.resourcePlatform ?? null,
		fileType: shortAuditValue(row.file_type),
		sourcePlatform: shortAuditValue(row.source_platform),
		hasAcademicEnrichment: row.has_academic_enrichment,
		hasPlatformData: row.has_platform_data,
		metadataVariant: shortAuditValue(row.metadata_variant),
		metadataExternalUrlMatchesResourceUrl: row.metadata_external_url_matches_resource_url,
		detectorPlatform: audited.detectorPlatform,
		currentKind: shortAuditValue(row.kind),
		currentResourcePlatform: shortAuditValue(row.resource_platform),
		disposition: audited.disposition,
		enrichedDetectorMismatch: audited.enrichedDetectorMismatch,
		blocking: audited.blocking,
		count: 1,
		sampleResourceIds: [row.id],
	};
}

function auditGroupKey(group: ResourceIdentityAuditGroup): string {
	return JSON.stringify([
		group.legacyType,
		group.enrichmentStatus,
		group.expectedKind,
		group.expectedResourcePlatform,
		group.fileType,
		group.sourcePlatform,
		group.hasAcademicEnrichment,
		group.hasPlatformData,
		group.metadataVariant,
		group.metadataExternalUrlMatchesResourceUrl,
		group.detectorPlatform,
		group.currentKind,
		group.currentResourcePlatform,
		group.disposition,
		group.enrichedDetectorMismatch,
		group.blocking,
	]);
}

function addAuditGroup(groups: Map<string, ResourceIdentityAuditGroup>, group: ResourceIdentityAuditGroup): void {
	const key = auditGroupKey(group);
	const existing = groups.get(key);
	if (existing) {
		existing.count += group.count;
		for (const resourceId of group.sampleResourceIds) {
			if (existing.sampleResourceIds.length >= 5) break;
			if (!existing.sampleResourceIds.includes(resourceId)) existing.sampleResourceIds.push(resourceId);
		}
	} else {
		groups.set(key, { ...group, sampleResourceIds: [...group.sampleResourceIds] });
	}
}

function countersForRows(rows: ResourceIdentityBackfillRow[]): { counters: AuditCounters; groups: ResourceIdentityAuditGroup[] } {
	const counters = emptyCounters();
	const groups = new Map<string, ResourceIdentityAuditGroup>();
	for (const row of rows) {
		const audited = auditRow(row);
		counters.scanned++;
		if (audited.disposition === 'missing') counters.missing++;
		if (audited.disposition === 'missing' && !audited.blocking) counters.plannedWrites++;
		if (audited.disposition === 'match') counters.matches++;
		if (audited.disposition === 'conflict') counters.conflicts++;
		if (audited.disposition === 'unmapped') counters.unmapped++;
		if (audited.disposition !== 'missing' && !audited.currentIdentityValid) counters.invalidCurrentIdentities++;
		if (audited.enrichedDetectorMismatch) counters.enrichedDetectorMismatches++;
		if (audited.blocking) counters.blockingRows++;
		addAuditGroup(groups, auditGroup(row, audited));
	}
	return { counters, groups: [...groups.values()] };
}

function mergeCounters(target: AuditCounters, source: AuditCounters): void {
	target.scanned += source.scanned;
	target.missing += source.missing;
	target.plannedWrites += source.plannedWrites;
	target.matches += source.matches;
	target.conflicts += source.conflicts;
	target.unmapped += source.unmapped;
	target.invalidCurrentIdentities += source.invalidCurrentIdentities;
	target.enrichedDetectorMismatches += source.enrichedDetectorMismatches;
	target.blockingRows += source.blockingRows;
}

function mergeExistingAuditGroup(existing: ResourceIdentityAuditGroup, group: ResourceIdentityAuditGroup): void {
	existing.count += group.count;
	for (const resourceId of group.sampleResourceIds) {
		if (existing.sampleResourceIds.length >= 5) break;
		if (!existing.sampleResourceIds.includes(resourceId)) existing.sampleResourceIds.push(resourceId);
	}
}

function recordOverflowAuditGroup(target: AuditAccumulator, group: ResourceIdentityAuditGroup): void {
	target.overflowGroups++;
	target.overflowRows += group.count;
	if (!group.blocking) return;

	target.overflowBlockingGroups++;
	target.overflowBlockingRows += group.count;
	for (const resourceId of group.sampleResourceIds) {
		if (target.overflowBlockingSampleResourceIds.length >= 20) break;
		if (!target.overflowBlockingSampleResourceIds.includes(resourceId)) {
			target.overflowBlockingSampleResourceIds.push(resourceId);
		}
	}
}

function mergeAuditGroup(target: AuditAccumulator, group: ResourceIdentityAuditGroup): void {
	const key = auditGroupKey(group);
	const groups = group.blocking ? target.blockingGroups : target.nonBlockingGroups;
	const limit = group.blocking ? MAX_BLOCKING_AUDIT_GROUPS : MAX_NONBLOCKING_AUDIT_GROUPS;
	const existing = groups.get(key);
	if (existing) {
		mergeExistingAuditGroup(existing, group);
		return;
	}
	if (groups.size < limit) {
		groups.set(key, { ...group, sampleResourceIds: [...group.sampleResourceIds] });
		return;
	}
	recordOverflowAuditGroup(target, group);
}

function mergeAuditPage(target: AuditAccumulator, page: AuditPage): void {
	mergeCounters(target.counters, page.counters);
	for (const group of page.groups) {
		mergeAuditGroup(target, group);
	}
}

function finalizedAudit(accumulator: AuditAccumulator, pages: number): ResourceIdentityAudit {
	return {
		...accumulator.counters,
		pages,
		groups: [...accumulator.blockingGroups.values(), ...accumulator.nonBlockingGroups.values()].sort((left, right) =>
			auditGroupKey(left).localeCompare(auditGroupKey(right)),
		),
		overflowGroups: accumulator.overflowGroups,
		overflowRows: accumulator.overflowRows,
		overflowBlockingGroups: accumulator.overflowBlockingGroups,
		overflowBlockingRows: accumulator.overflowBlockingRows,
		overflowBlockingSampleResourceIds: accumulator.overflowBlockingSampleResourceIds,
	};
}

async function queryPage(
	env: CoreEnv,
	cursor: string | null,
	snapshotAt: string,
): Promise<{ rows: ResourceIdentityBackfillRow[]; nextCursor: string | null }> {
	return withCoreDb(env, async (_db, client) => {
		const result = await client.query<ResourceIdentityBackfillRow>(
			`
				SELECT
					r.id::text AS id,
					r.type AS legacy_type,
					r.enrichment_status,
					r.url,
					r.file_type,
					s.platform AS source_platform,
					COALESCE(
						jsonb_typeof(r.platform_metadata #> '{enrichments,academic}') = 'object'
							AND r.platform_metadata #>> '{enrichments,academic,source}' = 'semanticscholar',
						false
					) AS has_academic_enrichment,
					COALESCE(jsonb_typeof(r.platform_metadata #> '{data}') = 'object', false) AS has_platform_data,
					r.platform_metadata #>> '{data,variant}' AS metadata_variant,
					COALESCE(
						NULLIF(r.platform_metadata #>> '{data,externalUrl}', '') = r.url,
						false
					) AS metadata_external_url_matches_resource_url,
					r.kind,
					r.resource_platform
				FROM resources r
				LEFT JOIN sources s ON s.id = r.source_id
				WHERE ($1::uuid IS NULL OR r.id > $1::uuid)
					AND r.created_at <= ($2::timestamptz AT TIME ZONE 'UTC')
				ORDER BY r.id
				LIMIT $3
			`,
			[cursor, snapshotAt, PAGE_SIZE + 1],
		);
		const hasMore = result.rows.length > PAGE_SIZE;
		const rows = result.rows.slice(0, PAGE_SIZE);
		return {
			rows,
			nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
		};
	});
}

async function auditPage(env: CoreEnv, cursor: string | null, snapshotAt: string): Promise<AuditPage> {
	const page = await queryPage(env, cursor, snapshotAt);
	const audit = countersForRows(page.rows);
	return { nextCursor: page.nextCursor, ...audit };
}

function unsafeWriteRows(rows: ResourceIdentityBackfillRow[], mode: ResourceIdentityWriteMode): ResourceIdentityBackfillRow[] {
	return rows.filter((row) => {
		const audited = auditRow(row);
		return audited.blocking || (mode === 'convergence' && audited.disposition !== 'match');
	});
}

async function writePage(env: CoreEnv, cursor: string | null, snapshotAt: string, mode: ResourceIdentityWriteMode): Promise<WritePage> {
	return withCoreTx(env, async (_db, client) => {
		const result = await client.query<ResourceIdentityBackfillRow>(
			`
				SELECT
					r.id::text AS id,
					r.type AS legacy_type,
					r.enrichment_status,
					r.url,
					r.file_type,
					s.platform AS source_platform,
					COALESCE(
						jsonb_typeof(r.platform_metadata #> '{enrichments,academic}') = 'object'
							AND r.platform_metadata #>> '{enrichments,academic,source}' = 'semanticscholar',
						false
					) AS has_academic_enrichment,
					COALESCE(jsonb_typeof(r.platform_metadata #> '{data}') = 'object', false) AS has_platform_data,
					r.platform_metadata #>> '{data,variant}' AS metadata_variant,
					COALESCE(
						NULLIF(r.platform_metadata #>> '{data,externalUrl}', '') = r.url,
						false
					) AS metadata_external_url_matches_resource_url,
					r.kind,
					r.resource_platform
				FROM resources r
				LEFT JOIN sources s ON s.id = r.source_id
				WHERE ($1::uuid IS NULL OR r.id > $1::uuid)
					AND r.created_at <= ($2::timestamptz AT TIME ZONE 'UTC')
				ORDER BY r.id
				LIMIT $3
				FOR UPDATE OF r
			`,
			[cursor, snapshotAt, PAGE_SIZE + 1],
		);
		const hasMore = result.rows.length > PAGE_SIZE;
		const rows = result.rows.slice(0, PAGE_SIZE);
		const unsafe = unsafeWriteRows(rows, mode);
		if (unsafe.length > 0) {
			throw new NonRetryableError(
				`Resource identity ${mode} page changed after preflight; ${unsafe.length} row(s) are unsafe`,
				'ResourceIdentityBackfillConcurrentDriftError',
			);
		}

		const candidates = rows.flatMap((row) => {
			const audited = auditRow(row);
			if (!audited.expected) return [];
			if (mode === 'write' && audited.disposition !== 'missing') return [];
			if (mode === 'convergence' && audited.disposition !== 'match') return [];
			return [{ id: row.id, kind: audited.expected.kind, resource_platform: audited.expected.resourcePlatform }];
		});
		let changed = 0;
		if (candidates.length > 0) {
			const update = await client.query(
				`
					UPDATE resources AS r
					SET
						kind = expected.kind,
						resource_platform = expected.resource_platform
					FROM jsonb_to_recordset($1::jsonb)
						AS expected(id uuid, kind text, resource_platform text)
					WHERE r.id = expected.id
						AND r.kind IS NULL
						AND r.resource_platform IS NULL
				`,
				[JSON.stringify(candidates)],
			);
			changed = update.rowCount ?? 0;
		}
		if (mode === 'convergence' && changed > 0) {
			throw new NonRetryableError(
				`Resource identity convergence guard unexpectedly matched ${changed} row(s); transaction rolled back`,
				'ResourceIdentityBackfillNotConvergedError',
			);
		}

		return {
			nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null,
			scanned: rows.length,
			planned: mode === 'write' ? candidates.length : 0,
			probed: mode === 'convergence' ? candidates.length : 0,
			changed,
			alreadyMatched: mode === 'convergence' ? rows.length : rows.length - candidates.length,
		};
	});
}

async function scanAudit(env: CoreEnv, step: WorkflowStep, phase: 'before' | 'after', snapshotAt: string): Promise<ResourceIdentityAudit> {
	let cursor: string | null = null;
	const accumulator = emptyAuditAccumulator();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const result = await step.do(`${phase}-resource-identity-audit-page-${page}`, DB_STEP_CONFIG, () => auditPage(env, cursor, snapshotAt));
		mergeAuditPage(accumulator, result);
		if (!result.nextCursor) return finalizedAudit(accumulator, page);
		cursor = result.nextCursor;
	}
	throw new NonRetryableError(`Resource identity ${phase} audit exceeded ${MAX_PAGES} pages`, 'ResourceIdentityBackfillPageLimitError');
}

async function applyWrites(env: CoreEnv, step: WorkflowStep, snapshotAt: string, mode: ResourceIdentityWriteMode): Promise<WriteSummary> {
	let cursor: string | null = null;
	const summary = emptyWriteSummary();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const result = await step.do(`${mode}-resource-identity-page-${page}`, DB_STEP_CONFIG, () => writePage(env, cursor, snapshotAt, mode));
		summary.pages = page;
		summary.scanned += result.scanned;
		summary.planned += result.planned;
		summary.probed += result.probed;
		summary.changed += result.changed;
		summary.alreadyMatched += result.alreadyMatched;
		if (!result.nextCursor) return summary;
		cursor = result.nextCursor;
	}
	throw new NonRetryableError(`Resource identity write exceeded ${MAX_PAGES} pages`, 'ResourceIdentityBackfillPageLimitError');
}

function validIdentityRows(): Array<{ kind: ResourceKind; resource_platform: ResourcePlatform }> {
	return RESOURCE_KINDS.flatMap((kind) =>
		VALID_KIND_PLATFORMS[kind].map((resourcePlatform) => ({ kind, resource_platform: resourcePlatform })),
	);
}

async function loadInvariantCounters(env: CoreEnv, snapshotAt: string): Promise<ResourceIdentityInvariantCounters> {
	return withCoreDb(env, async (_db, client) => {
		const result = await client.query<{
			scanned: string;
			missing_kind: string;
			platform_without_kind: string;
			invalid_kind: string;
			invalid_platform: string;
			invalid_kind_platform: string;
		}>(
			`
				WITH valid_identity AS (
					SELECT identity.kind, identity.resource_platform
					FROM jsonb_to_recordset($4::jsonb)
						AS identity(kind text, resource_platform text)
				)
				SELECT
					COUNT(*)::text AS scanned,
					COUNT(*) FILTER (WHERE r.kind IS NULL)::text AS missing_kind,
					COUNT(*) FILTER (WHERE r.kind IS NULL AND r.resource_platform IS NOT NULL)::text AS platform_without_kind,
					COUNT(*) FILTER (
						WHERE r.kind IS NOT NULL AND NOT (r.kind = ANY($2::text[]))
					)::text AS invalid_kind,
					COUNT(*) FILTER (
						WHERE r.resource_platform IS NOT NULL AND NOT (r.resource_platform = ANY($3::text[]))
					)::text AS invalid_platform,
					COUNT(*) FILTER (
						WHERE r.kind IS NOT NULL
							AND NOT EXISTS (
								SELECT 1
								FROM valid_identity valid
								WHERE valid.kind = r.kind
									AND valid.resource_platform IS NOT DISTINCT FROM r.resource_platform
							)
					)::text AS invalid_kind_platform
				FROM resources r
				WHERE r.created_at <= ($1::timestamptz AT TIME ZONE 'UTC')
			`,
			[snapshotAt, [...RESOURCE_KINDS], [...RESOURCE_PLATFORMS], JSON.stringify(validIdentityRows())],
		);
		const row = result.rows[0];
		return {
			scanned: Number(row?.scanned ?? 0),
			missingKind: Number(row?.missing_kind ?? 0),
			platformWithoutKind: Number(row?.platform_without_kind ?? 0),
			invalidKind: Number(row?.invalid_kind ?? 0),
			invalidPlatform: Number(row?.invalid_platform ?? 0),
			invalidKindPlatform: Number(row?.invalid_kind_platform ?? 0),
		};
	});
}

function assertPreflightAllowsWrite(mode: ResourceIdentityBackfillMode, before: ResourceIdentityAudit): void {
	if (mode !== 'write' && mode !== 'convergence') return;
	if (before.blockingRows > 0) {
		throw new NonRetryableError(
			`Resource identity preflight found ${before.blockingRows} blocking row(s); no writes were attempted`,
			'ResourceIdentityBackfillPreflightError',
		);
	}
	if (mode === 'convergence' && before.plannedWrites > 0) {
		throw new NonRetryableError(
			`Resource identity convergence would change ${before.plannedWrites} row(s); no writes were attempted`,
			'ResourceIdentityBackfillNotConvergedError',
		);
	}
}

function assertFinalState(mode: ResourceIdentityBackfillMode, summary: ResourceIdentityBackfillSummary): void {
	if (mode !== 'write' && mode !== 'convergence') return;
	const { after, invariants } = summary;
	const failures =
		after.blockingRows +
		after.missing +
		invariants.missingKind +
		invariants.platformWithoutKind +
		invariants.invalidKind +
		invariants.invalidPlatform +
		invariants.invalidKindPlatform;
	if (failures > 0) {
		throw new NonRetryableError(
			`Resource identity final audit found ${failures} invariant failure(s)`,
			'ResourceIdentityBackfillInvariantError',
		);
	}
	if (mode === 'convergence' && summary.write.changed > 0) {
		throw new NonRetryableError(
			`Resource identity convergence changed ${summary.write.changed} row(s)`,
			'ResourceIdentityBackfillNotConvergedError',
		);
	}
}

function compactAuditResult(audit: ResourceIdentityAudit): ResourceIdentityAuditResult {
	const { groups, ...counters } = audit;
	const blockingGroups = groups.filter((group) => group.blocking).slice(0, MAX_RESULT_AUDIT_GROUPS);
	const remaining = MAX_RESULT_AUDIT_GROUPS - blockingGroups.length;
	const nonBlockingGroups = groups.filter((group) => !group.blocking).slice(0, remaining);
	return { ...counters, sampleGroups: [...blockingGroups, ...nonBlockingGroups] };
}

function compactBackfillResult(summary: ResourceIdentityBackfillSummary): ResourceIdentityBackfillResult {
	return {
		mode: summary.mode,
		snapshotAt: summary.snapshotAt,
		before: compactAuditResult(summary.before),
		write: summary.write,
		after: compactAuditResult(summary.after),
		invariants: summary.invariants,
	};
}

async function recordSummary(step: WorkflowStep, result: ResourceIdentityBackfillResult) {
	return step.do(
		'record-resource-identity-backfill-summary',
		{ retries: { limit: 0, delay: '1 second' }, timeout: '5 seconds' },
		async () => {
			console.info({
				tag: 'RESOURCE_IDENTITY',
				event: 'resource_identity_backfill_completed',
				...result,
			});
			return result;
		},
	);
}

export function resourceIdentityBackfillInstanceId(mode: ResourceIdentityBackfillMode): string {
	return WORKFLOW_IDS[parseMode(mode)];
}

export function startResourceIdentityBackfill(env: CoreEnv, mode: ResourceIdentityBackfillMode = 'dry-run'): Promise<string> {
	const parsedMode = parseMode(mode);
	return enqueueOrRestartWorkflow(env.RESOURCE_IDENTITY_BACKFILL_WORKFLOW, resourceIdentityBackfillInstanceId(parsedMode), {
		mode: parsedMode,
	});
}

export class ResourceIdentityBackfillWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceIdentityBackfillPayload> {
	async run(event: WorkflowEvent<ResourceIdentityBackfillPayload>, step: WorkflowStep) {
		const mode = parseMode(event.payload.mode);
		const snapshotAt = await step.do(
			'resolve-resource-identity-backfill-snapshot',
			{ retries: { limit: 0, delay: '1 second' }, timeout: '5 seconds' },
			async () => new Date().toISOString(),
		);
		const before = await scanAudit(this.env, step, 'before', snapshotAt);
		await step.do(
			'record-resource-identity-backfill-preflight',
			{ retries: { limit: 0, delay: '1 second' }, timeout: '5 seconds' },
			async () => {
				const result = compactAuditResult(before);
				console.info({
					tag: 'RESOURCE_IDENTITY',
					event: 'resource_identity_backfill_preflight',
					mode,
					snapshotAt,
					...result,
				});
				return result;
			},
		);
		assertPreflightAllowsWrite(mode, before);

		const write = mode === 'write' || mode === 'convergence' ? await applyWrites(this.env, step, snapshotAt, mode) : emptyWriteSummary();
		const after = mode === 'write' || mode === 'convergence' ? await scanAudit(this.env, step, 'after', snapshotAt) : before;
		const invariants = await step.do('load-resource-identity-backfill-invariants', DB_STEP_CONFIG, () =>
			loadInvariantCounters(this.env, snapshotAt),
		);
		const summary = { mode, snapshotAt, before, write, after, invariants } satisfies ResourceIdentityBackfillSummary;
		assertFinalState(mode, summary);
		return recordSummary(step, compactBackfillResult(summary));
	}
}
