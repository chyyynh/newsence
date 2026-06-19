// ─────────────────────────────────────────────────────────────
// HackerNews Scraper
// ─────────────────────────────────────────────────────────────

import { buildMetadata, type HackerNewsMetadata, type PlatformMetadata } from '@shared/platform-metadata';
import { fetchJsonWithTimeout, type ScrapedContent } from '@shared/web';

const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';

export interface HnComment {
	id?: number;
	author?: string;
	text?: string;
	children?: HnComment[];
}

export interface HnItem {
	id: number;
	title?: string;
	url?: string;
	author?: string;
	points?: number;
	descendants?: number;
	type: 'story' | 'ask' | 'show' | 'job' | 'comment' | 'poll';
	created_at_i?: number;
	text?: string;
	children?: HnComment[];
}

export function hnItemTypeForMetadata(type: HnItem['type'] | undefined): 'story' | 'ask' | 'show' | 'job' {
	if (type === 'ask' || type === 'show' || type === 'job') return type;
	return 'story';
}

export function buildHnMetadata(item: HnItem, storyUrl: string | null = item.url ?? null): HackerNewsMetadata {
	return {
		itemId: item.id.toString(),
		author: item.author ?? '',
		points: item.points ?? 0,
		commentCount: item.descendants ?? 0,
		itemType: hnItemTypeForMetadata(item.type),
		storyUrl,
	};
}

export function buildHnPlatformMetadata(item: HnItem, storyUrl?: string | null): Extract<PlatformMetadata, { type: 'hackernews' }> {
	return buildMetadata('hackernews', buildHnMetadata(item, storyUrl));
}

export async function fetchHnItem(itemId: string | number): Promise<HnItem> {
	return fetchJsonWithTimeout<HnItem>(`${HN_ALGOLIA_API}/${itemId}`);
}

function buildHnMarkdown(item: HnItem): string {
	const title = item.title || `HN Item ${item.id}`;
	const parts: string[] = [`# ${title}\n`];

	const metaParts: string[] = [];
	if (item.points !== undefined) metaParts.push(`${item.points} points`);
	if (item.author) metaParts.push(`by ${item.author}`);
	if (item.descendants !== undefined) metaParts.push(`${item.descendants} comments`);
	if (metaParts.length) parts.push(`*${metaParts.join(' | ')}*\n`);

	if (item.url) parts.push(`**Original:** [${item.url}](${item.url})\n`);
	if (item.text) parts.push(`---\n\n${item.text}\n`);

	parts.push(`\n---\n\n[View Discussion on Hacker News](https://news.ycombinator.com/item?id=${item.id})`);

	return parts.join('\n');
}

export async function scrapeHackerNews(itemId: string): Promise<ScrapedContent> {
	console.info({ tag: 'HN', msg: 'Fetching item', itemId });

	const item = await fetchHnItem(itemId);

	const title = item.title || `HN Item ${itemId}`;
	let summary = item.text?.slice(0, 200) || title;
	if (item.text && item.text.length > 200) summary += '...';

	console.info({ tag: 'HN', msg: 'Item fetched', title });

	return {
		title,
		content: buildHnMarkdown(item),
		summary,
		ogImageUrl: null,
		siteName: 'Hacker News',
		author: item.author || null,
		publishedDate: item.created_at_i ? new Date(item.created_at_i * 1000).toISOString() : null,
		metadata: { ...buildHnMetadata(item) },
	};
}
