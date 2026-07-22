import type { SourceAcquisitionMode, SourcePlatform } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { sources } from '@db/schema';
import { and, eq, inArray } from 'drizzle-orm';

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
			.where(and(eq(sources.monitoringEnabled, true), eq(sources.platform, platform))),
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

function parseFailureCount(state: unknown): number {
	if (typeof state !== 'object' || state === null) return 0;
	const count = (state as { consecutiveFailures?: unknown }).consecutiveFailures;
	return typeof count === 'number' && Number.isFinite(count) ? count : 0;
}

// Never throws: failure bookkeeping must not break cron error isolation.
export async function recordSourceFailure(env: CoreEnv, sourceId: string, error: unknown): Promise<void> {
	const failedAt = new Date();
	try {
		await withCoreDb(env, async (db) => {
			const row = (
				await db.select({ status: sources.status, scrapeState: sources.scrapeState }).from(sources).where(eq(sources.id, sourceId)).limit(1)
			)[0];
			if (!row) return;
			const consecutiveFailures = parseFailureCount(row.scrapeState) + 1;
			// A pending source that keeps failing never validated — stop burning
			// cron fetches on it. Active sources ride out transient outages;
			// only the counters move.
			const neverValidated = row.status === 'pending' && consecutiveFailures >= PENDING_VALIDATION_FAILURE_LIMIT;
			await db
				.update(sources)
				.set({
					scrapeState: {
						consecutiveFailures,
						lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
						lastFailureAt: failedAt.toISOString(),
					},
					updatedAt: failedAt,
					...(neverValidated ? { status: 'failed' as const, monitoringEnabled: false } : {}),
				})
				.where(eq(sources.id, sourceId));
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
