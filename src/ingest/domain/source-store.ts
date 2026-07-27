import type { SourceAcquisitionMode, SourcePlatform } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { sources } from '@db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

export type MonitoredSource = {
	id: string;
	name: string;
	handle: string;
	acquisitionMode: SourceAcquisitionMode;
	scrapedAt: Date | null;
	createdAt: Date;
};

type RssAcquisitionMode = Extract<SourceAcquisitionMode, 'feed' | 'web'>;

type RssSourcePolicy = {
	id: string;
	name: string;
	handle: string;
	acquisitionMode: RssAcquisitionMode;
};

export function parseRssAcquisitionMode(value: unknown, source: string): RssAcquisitionMode {
	if (value === 'feed' || value === 'web') return value;
	throw new Error(`RSS source ${source} has invalid acquisition mode: ${String(value)}`);
}

/**
 * Enabled sources of one platform that are due to be polled. A null
 * pollIntervalMinutes means every firing, so sources that never set one behave
 * exactly as before; setting it lets one monitor carry feeds whose publishers
 * update at very different rates.
 */
export async function loadMonitoredSources(env: CoreEnv, platform: SourcePlatform): Promise<MonitoredSource[]> {
	return withCoreDb(env, async (db: CoreDb) =>
		db
			.select({
				id: sources.id,
				name: sources.name,
				handle: sources.handle,
				acquisitionMode: sources.acquisitionMode,
				scrapedAt: sources.scrapedAt,
				createdAt: sources.createdAt,
			})
			.from(sources)
			.where(
				and(
					eq(sources.monitoringEnabled, true),
					eq(sources.platform, platform),
					sql`(
						${sources.pollIntervalMinutes} IS NULL
						OR ${sources.scrapedAt} IS NULL
						OR ${sources.scrapedAt} < NOW() - (INTERVAL '1 minute' * ${sources.pollIntervalMinutes})
					)`,
				),
			),
	);
}

export async function markSourceScraped(env: CoreEnv, sourceId: string, scrapedAt: Date = new Date()): Promise<void> {
	await markSourcesScraped(env, [sourceId], scrapedAt);
}

export async function loadRssSourcePolicy(env: CoreEnv, sourceId: string): Promise<RssSourcePolicy> {
	return withCoreDb(env, async (db) => {
		const source = (
			await db
				.select({ id: sources.id, name: sources.name, handle: sources.handle, acquisitionMode: sources.acquisitionMode })
				.from(sources)
				.where(and(eq(sources.id, sourceId), eq(sources.platform, 'rss')))
				.limit(1)
		)[0];
		if (!source) throw new Error(`RSS source ${sourceId} was not found`);
		return { ...source, acquisitionMode: parseRssAcquisitionMode(source.acquisitionMode, source.name) };
	});
}

export async function markSourcesScraped(env: CoreEnv, sourceIds: string[], scrapedAt: Date = new Date()): Promise<void> {
	if (!sourceIds.length) return;
	await withCoreDb(env, async (db) => {
		// Success also settles the #237 lifecycle: pending/failed rows become
		// active and the scrape_state failure counters reset.
		await db
			.update(sources)
			.set({ scrapedAt, updatedAt: scrapedAt, status: 'active', scrapeState: null })
			.where(inArray(sources.id, sourceIds));
	});
}

const PENDING_VALIDATION_FAILURE_LIMIT = 3;

// Never throws: failure bookkeeping must not break cron error isolation.
// Single statement: bumps the counter and flips a pending source to failed
// (and off) once it exhausts validation attempts; active sources ride out
// transient outages — only the counters move.
export async function recordSourceFailure(env: CoreEnv, sourceId: string, error: unknown): Promise<void> {
	const failedAt = new Date();
	const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
	try {
		await withCoreDb(env, async (db) => {
			await db.execute(sql`
				UPDATE sources SET
					scrape_state = jsonb_build_object(
						'consecutiveFailures', COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1,
						'lastError', ${message}::text,
						'lastFailureAt', ${failedAt.toISOString()}::text
					),
					status = CASE
						WHEN status = 'pending' AND COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1 >= ${PENDING_VALIDATION_FAILURE_LIMIT}
						THEN 'failed' ELSE status END,
					enabled = CASE
						WHEN status = 'pending' AND COALESCE((scrape_state->>'consecutiveFailures')::int, 0) + 1 >= ${PENDING_VALIDATION_FAILURE_LIMIT}
						THEN false ELSE enabled END,
					updated_at = ${failedAt}
				WHERE id = ${sourceId}
			`);
		});
	} catch (recordError) {
		console.error({
			tag: 'SOURCES',
			msg: 'Failed to record source failure',
			sourceId,
			error: recordError instanceof Error ? recordError.message : String(recordError),
		});
	}
}
