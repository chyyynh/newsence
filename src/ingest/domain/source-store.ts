import type { SourcePlatform } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { sources } from '@db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export type MonitoredSource = {
	id: string;
	name: string;
	handle: string;
	scrapedAt: Date | null;
	scrapeState: unknown;
};

export async function loadEnabledSources(env: CoreEnv, platform: SourcePlatform): Promise<MonitoredSource[]> {
	return withCoreDb(env, async (db: CoreDb) =>
		db
			.select({
				id: sources.id,
				name: sources.name,
				handle: sources.handle,
				scrapedAt: sources.scrapedAt,
				scrapeState: sources.scrapeState,
			})
			.from(sources)
			.where(and(eq(sources.enabled, true), eq(sources.platform, platform))),
	);
}

export async function markSourceScraped(env: CoreEnv, sourceId: string, scrapedAt: Date = new Date()): Promise<void> {
	await markSourcesScraped(env, [sourceId], scrapedAt);
}

export async function markSourcesScraped(env: CoreEnv, sourceIds: string[], scrapedAt: Date = new Date()): Promise<void> {
	if (!sourceIds.length) return;
	await withCoreDb(env, async (db) => {
		await db.update(sources).set({ scrapedAt, updatedAt: scrapedAt }).where(inArray(sources.id, sourceIds));
	});
}

export async function markSourceScrapedWithState(env: CoreEnv, sourceId: string, scrapeState: unknown): Promise<void> {
	const scrapedAt = new Date();
	await withCoreDb(env, async (db) => {
		await db.update(sources).set({ scrapedAt, scrapeState, updatedAt: scrapedAt }).where(eq(sources.id, sourceId));
	});
}
