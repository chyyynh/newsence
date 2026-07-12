import type { SourcePlatform } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb } from '@db/client';
import { sources } from '@db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export type MonitoredSource = {
	id: string;
	name: string;
	handle: string;
	contentMode: string | null;
	scrapedAt: Date | null;
	createdAt: Date;
};

export type RssContentMode = 'feed' | 'web';

export type RssSourcePolicy = {
	id: string;
	name: string;
	handle: string;
	contentMode: RssContentMode;
};

export function parseRssContentMode(value: unknown, source: string): RssContentMode {
	if (value === 'feed' || value === 'web') return value;
	throw new Error(`RSS source ${source} has invalid content mode: ${String(value)}`);
}

export async function loadEnabledSources(env: CoreEnv, platform: SourcePlatform): Promise<MonitoredSource[]> {
	return withCoreDb(env, async (db: CoreDb) =>
		db
			.select({
				id: sources.id,
				name: sources.name,
				handle: sources.handle,
				contentMode: sources.contentMode,
				scrapedAt: sources.scrapedAt,
				createdAt: sources.createdAt,
			})
			.from(sources)
			.where(and(eq(sources.enabled, true), eq(sources.platform, platform))),
	);
}

export async function markSourceScraped(env: CoreEnv, sourceId: string, scrapedAt: Date = new Date()): Promise<void> {
	await markSourcesScraped(env, [sourceId], scrapedAt);
}

export async function loadRssSourcePolicy(env: CoreEnv, sourceId: string): Promise<RssSourcePolicy> {
	return withCoreDb(env, async (db) => {
		const source = (
			await db
				.select({ id: sources.id, name: sources.name, handle: sources.handle, contentMode: sources.contentMode })
				.from(sources)
				.where(and(eq(sources.id, sourceId), eq(sources.platform, 'rss')))
				.limit(1)
		)[0];
		if (!source) throw new Error(`RSS source ${sourceId} was not found`);
		return { ...source, contentMode: parseRssContentMode(source.contentMode, source.name) };
	});
}

export async function markSourcesScraped(env: CoreEnv, sourceIds: string[], scrapedAt: Date = new Date()): Promise<void> {
	if (!sourceIds.length) return;
	await withCoreDb(env, async (db) => {
		await db.update(sources).set({ scrapedAt, updatedAt: scrapedAt }).where(inArray(sources.id, sourceIds));
	});
}
