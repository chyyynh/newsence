import { ingestUrls as ingestUrlsForUser } from '@ingest/urls';
import type { Env } from '@shared/types';
import type { ArticleSummary, CorpusReadItem, CorpusReadResult } from '../corpus';
import { readCorpusItems, searchCorpusArticles } from '../corpus';

/** Crawl + save external URLs to a user's library; returns created user_file IDs. */
export async function ingestUrls(env: Env, urls: string[], userId: string): Promise<string[]> {
	if (urls.length === 0) return [];
	try {
		const outcome = await ingestUrlsForUser(env, { urls, userId });
		return outcome.ok ? outcome.results.map((r) => r.userFileId).filter((id): id is string => !!id) : [];
	} catch (err) {
		console.error({ tag: 'CORE', msg: 'ingestUrls failed', error: String(err) });
		return [];
	}
}

/** Hybrid article search (embeddings + keywords) for the chat search-news tool. */
export function searchArticles(env: Env, query: string, opts?: { daysAgo?: number; limit?: number }): Promise<ArticleSummary[]> {
	return searchCorpusArticles(env, query, opts);
}

/** Read article/collection/url resources from the core corpus (documents are read via Vercel). */
export function readItems(env: Env, items: CorpusReadItem[], userId: string): Promise<CorpusReadResult[]> {
	return readCorpusItems(env, items, userId);
}

export type { ArticleSummary, CorpusReadItem, CorpusReadResult };
