import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { withCoreDb } from '@db/client';
import { isExplicitPaperUrl, stagePaperEnrichmentAttempt } from '@ingest/platforms/paper';
import { persistAcademicMetadataBackfill } from '@ingest/resource-persistence';
import { syncCorpusItem } from '../ai-search';
import { assertResourceWritesEnabled } from '../db/resource-write-guard';
import { enqueueOrRestartWorkflow } from '../workflow-control';

const PAGE_SIZE = 10;
const MAX_PAGES = 2500;
const ACADEMIC_SCHEMA_VERSION = 2;
const WORKFLOW_ID = `academic-metadata-backfill-v${ACADEMIC_SCHEMA_VERSION}-canonical-v3`;
const PROVIDER_REQUEST_INTERVAL = '3 seconds';

type AcademicMetadataBackfillPayload = Record<string, never>;

type AcademicMetadataBackfillCandidate = {
	id: string;
	url: string;
	hasExistingAcademic: boolean;
};

type AcademicMetadataBackfillPage = {
	items: AcademicMetadataBackfillCandidate[];
	nextCursor: string | null;
};

export type AcademicMetadataBackfillSummary = {
	pages: number;
	scanned: number;
	resolved: number;
	upgraded: number;
	preserved: number;
	notFound: number;
	failed: number;
	skipped: number;
};

async function loadAcademicMetadataBackfillPage(env: CoreEnv, cursor: string | null, limit: number): Promise<AcademicMetadataBackfillPage> {
	return withCoreDb(env, async (_db, client) => {
		const result = await client.query<{
			id: string;
			url: string;
			has_existing_academic: boolean;
		}>(
			`
				SELECT
					id::text AS id,
					COALESCE(
						NULLIF(url, ''),
						'https://doi.org/' || (platform_metadata #>> '{enrichments,academic,doi}')
					) AS url,
					COALESCE(jsonb_typeof(platform_metadata #> '{enrichments,academic}') = 'object', false) AS has_existing_academic
				FROM resources
				WHERE ($1::uuid IS NULL OR id > $1::uuid)
					AND (
						lower(COALESCE(url, '')) ~ '^https?://([a-z0-9-]+\\.)*arxiv\\.org/(abs|html|pdf)/[0-9]{4}\\.[0-9]{4,5}(v[0-9]+)?(\\.pdf)?/?([?#].*)?$'
						OR lower(COALESCE(url, '')) ~ '^https?://(dx\\.)?doi\\.org/10\\.[0-9]{4,9}/'
						OR (
							file_type = 'application/pdf'
							AND COALESCE(platform_metadata #>> '{enrichments,academic,doi}', '') ~* '^10\\.[0-9]{4,9}/'
						)
					)
					AND COALESCE(platform_metadata #>> '{enrichments,academic,schemaVersion}', '') <> $3
				ORDER BY id
				LIMIT $2
			`,
			[cursor, limit, String(ACADEMIC_SCHEMA_VERSION)],
		);
		const rows = result.rows;
		const items = rows
			.filter((row) => isExplicitPaperUrl(row.url))
			.map((row) => ({
				id: row.id,
				url: row.url,
				hasExistingAcademic: row.has_existing_academic,
			}));
		return {
			items,
			nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
		};
	});
}

function emptySummary(): AcademicMetadataBackfillSummary {
	return {
		pages: 0,
		scanned: 0,
		resolved: 0,
		upgraded: 0,
		preserved: 0,
		notFound: 0,
		failed: 0,
		skipped: 0,
	};
}

async function recordSummary(step: WorkflowStep, summary: AcademicMetadataBackfillSummary) {
	return step.do(
		'record-academic-metadata-backfill-summary',
		{ retries: { limit: 0, delay: '1 second' }, timeout: '5 seconds' },
		async () => {
			console.info({ tag: 'S2', event: 'academic_metadata_backfill_completed', ...summary });
			return summary;
		},
	);
}

export async function startAcademicMetadataBackfill(env: CoreEnv): Promise<string> {
	await assertResourceWritesEnabled(env, 'academic metadata backfill enqueue');
	return enqueueOrRestartWorkflow(env.ACADEMIC_METADATA_BACKFILL_V3_WORKFLOW, WORKFLOW_ID, {});
}

export class AcademicMetadataBackfillV3Workflow extends WorkflowEntrypoint<CoreEnv, AcademicMetadataBackfillPayload> {
	async run(_event: WorkflowEvent<AcademicMetadataBackfillPayload>, step: WorkflowStep) {
		await assertResourceWritesEnabled(this.env, 'academic metadata backfill workflow');
		let cursor: string | null = null;
		const summary = emptySummary();

		for (let page = 1; page <= MAX_PAGES; page++) {
			const result = await step.do(
				`load-academic-metadata-backfill-page-${page}`,
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => loadAcademicMetadataBackfillPage(this.env, cursor, PAGE_SIZE),
			);
			summary.pages = page;

			for (const [index, candidate] of result.items.entries()) {
				summary.scanned++;
				const itemNumber = index + 1;
				const attempt = await stagePaperEnrichmentAttempt(
					this.env,
					step,
					candidate,
					`resolve-academic-metadata-page-${page}-item-${itemNumber}`,
				);

				if (attempt.outcome === 'resolved' && attempt.metadata) {
					const metadata = attempt.metadata;
					summary.resolved++;
					const persistence = await step.do(
						`persist-academic-metadata-index-relevance-page-${page}-item-${itemNumber}-v2`,
						{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
						() => persistAcademicMetadataBackfill(this.env, candidate.id, metadata),
					);
					if (persistence.indexRelevantChanged) {
						// The transaction's locked before/after comparison is a
						// durable step result, so this conditional remains stable on
						// replay. A failed sync must fail the backfill item rather than
						// leave an acknowledged index drift.
						await step.do(
							`sync-ai-search-academic-metadata-page-${page}-item-${itemNumber}-v1`,
							{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
							() => syncCorpusItem(this.env, candidate.id),
						);
					}
					if (persistence.changed) summary.upgraded++;
					else summary.preserved++;
				} else if (attempt.outcome === 'preserved') {
					summary.preserved++;
				} else if (attempt.outcome === 'not_found') {
					summary.notFound++;
				} else if (attempt.outcome === 'failed') {
					summary.failed++;
				} else {
					summary.skipped++;
				}

				if (attempt.outcome !== 'not_applicable') {
					await step.sleep(`rate-limit-academic-metadata-page-${page}-item-${itemNumber}`, PROVIDER_REQUEST_INTERVAL);
				}
			}

			if (!result.nextCursor) return recordSummary(step, summary);
			cursor = result.nextCursor;
		}

		throw new NonRetryableError(`Academic metadata backfill exceeded ${MAX_PAGES} pages`, 'AcademicMetadataBackfillPageLimitError');
	}
}
