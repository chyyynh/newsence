import { type CoreDb, withCoreDb } from '@db/client';
import { sources } from '@db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import type { SourcePlatform } from '../../resources/types';

export type MonitoredSource = {
	id: string;
	name: string;
	handle: string;
	siteUrl: string | null;
	scrapedAt: Date | null;
};

export async function loadEnabledSources(env: CoreEnv, platform: SourcePlatform): Promise<MonitoredSource[]> {
	return withCoreDb(env, async (db: CoreDb) =>
		db
			.select({
				id: sources.id,
				name: sources.name,
				handle: sources.handle,
				siteUrl: sources.siteUrl,
				scrapedAt: sources.scrapedAt,
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
