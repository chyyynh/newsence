// ─────────────────────────────────────────────────────────────
// HackerNews Scraper
// ─────────────────────────────────────────────────────────────

import { fetchJsonWithTimeout, type ScrapedContent } from '@shared/web';

export const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';

interface HNItem {
	id: number;
	title: string;
	url?: string;
	author: string;
	points: number;
	descendants?: number;
	type: 'story' | 'ask' | 'show' | 'job' | 'comment' | 'poll';
	created_at_i: number;
	text?: string;
}

function buildHnMarkdown(item: HNItem): string {
	const parts: string[] = [`# ${item.title}\n`];

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

	const item = await fetchJsonWithTimeout<HNItem>(`${HN_ALGOLIA_API}/${itemId}`);

	let summary = item.text?.slice(0, 200) || item.title;
	if (item.text && item.text.length > 200) summary += '...';

	console.info({ tag: 'HN', msg: 'Item fetched', title: item.title });

	return {
		title: item.title || `HN Item ${itemId}`,
		content: buildHnMarkdown(item),
		summary,
		ogImageUrl: null,
		siteName: 'Hacker News',
		author: item.author || null,
		publishedDate: item.created_at_i ? new Date(item.created_at_i * 1000).toISOString() : null,
		metadata: {
			itemId: item.id.toString(),
			points: item.points || 0,
			commentCount: item.descendants || 0,
			itemType: item.type,
			author: item.author,
			storyUrl: item.url || null,
		},
	};
}
