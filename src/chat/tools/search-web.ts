// External web search via Exa. Pro-only — gated through `externalSearch` in
// the registry. Mirrors frontend/src/lib/ai/tools/search-web.ts.

import type { Env } from '@shared/types';
import { tool } from 'ai';
import Exa from 'exa-js';
import { z } from 'zod';

const SUMMARY_MAX = 500;
const TEXT_MAX_CHARS = 8000;
const DEFAULT_LIMIT = 10;

interface ExaResult {
	title: string;
	url: string;
	text?: string;
	publishedDate?: string;
}

export interface SearchWebResultItem {
	title: string;
	url: string;
	publishedDate?: string;
	summary?: string;
}

export type SearchWebResult = { results: SearchWebResultItem[] };

function formatResult(r: ExaResult): SearchWebResultItem {
	return {
		title: r.title || r.url,
		url: r.url,
		publishedDate: r.publishedDate,
		summary: r.text ? r.text.slice(0, SUMMARY_MAX) : undefined,
	};
}

export function createSearchWebTool(env: Env) {
	const apiKey = env.EXA_API_KEY;
	const client = apiKey ? new Exa(apiKey) : null;

	return tool({
		description:
			'Search the open web via Exa. Use ONLY when search-news returned nothing useful — your library is the first resort. ' +
			'Returns titles, URLs, and snippets — work directly from the snippet. read-context only reads URLs in the user library; it will NOT fetch full text for an Exa result.',
		inputSchema: z.object({
			query: z.string().describe('Search keywords or natural-language query'),
			limit: z.number().min(1).max(15).optional().describe('Max results (default 10)'),
		}),
		execute: async ({ query, limit }): Promise<SearchWebResult> => {
			if (!client) throw new Error('EXA_API_KEY is not configured');
			const response = await client.search(query, {
				numResults: limit ?? DEFAULT_LIMIT,
				type: 'auto',
				contents: { text: { maxCharacters: TEXT_MAX_CHARS } },
			});
			const results: ExaResult[] = response.results.map((r) => ({
				title: r.title ?? '',
				url: r.url,
				text: r.text ?? undefined,
				publishedDate: r.publishedDate ?? undefined,
			}));
			return { results: results.map(formatResult) };
		},
	});
}
