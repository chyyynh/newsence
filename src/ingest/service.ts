// Public service facade for the ingest domain — the ONLY module other domains
// (e.g. @chat) should import from @ingest. Internal files (@ingest/urls,
// @ingest/extract, @ingest/handlers/*) stay private. Args/returns are kept
// serializable so these promote to WorkerEntrypoint RPC methods unchanged when
// chat splits into its own worker (Cloudflare RPC ≈ calling a local function).

import type { Env } from '@shared/types';
import { extractSource, type NormalizedContent } from './extract';
import { ingestUrls } from './urls';

/** Crawl + save external URLs to a user's library; returns the created user_file IDs. */
export async function ingestUrlsForUser(env: Env, urls: string[], userId: string): Promise<string[]> {
	if (urls.length === 0) return [];
	try {
		const outcome = await ingestUrls(env, { urls, userId });
		return outcome.ok ? outcome.results.map((r) => r.userFileId).filter((id): id is string => !!id) : [];
	} catch (err) {
		console.error('[ingest.service] ingestUrlsForUser failed:', err);
		return [];
	}
}

/** Synchronous single-URL extraction → normalized content (markdown/text/metadata). */
export async function scrapeUrl(env: Env, url: string): Promise<NormalizedContent> {
	return extractSource(env, { kind: 'url', url });
}

export type { NormalizedContent } from './extract';
