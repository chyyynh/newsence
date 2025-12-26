import type { ScrapedContent } from '../types';

const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';

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
	children?: HNItem[];
}

/**
 * Builds markdown content from HN item
 */
function buildMarkdownContent(item: HNItem): string {
	const parts: string[] = [];

	// Title
	parts.push(`# ${item.title}\n`);

	// Meta info
	const metaParts: string[] = [];
	if (item.points !== undefined) {
		metaParts.push(`${item.points} points`);
	}
	if (item.author) {
		metaParts.push(`by ${item.author}`);
	}
	if (item.descendants !== undefined) {
		metaParts.push(`${item.descendants} comments`);
	}
	if (metaParts.length > 0) {
		parts.push(`*${metaParts.join(' | ')}*\n`);
	}

	// Original URL if exists
	if (item.url) {
		parts.push(`**Original:** [${item.url}](${item.url})\n`);
	}

	// Text content (for Ask HN, Show HN, etc.)
	if (item.text) {
		parts.push(`---\n\n${item.text}\n`);
	}

	// Discussion link
	parts.push(`\n---\n\n[View Discussion on Hacker News](https://news.ycombinator.com/item?id=${item.id})`);

	return parts.join('\n');
}

/**
 * Scrapes HackerNews item using Algolia API
 */
export async function scrapeHackerNews(itemId: string): Promise<ScrapedContent> {
	const response = await fetch(`${HN_ALGOLIA_API}/${itemId}`);

	if (!response.ok) {
		throw new Error(`Failed to fetch HN item: ${response.status} ${response.statusText}`);
	}

	const item: HNItem = await response.json();

	// Determine summary
	let summary = item.text?.slice(0, 200) || item.title;
	if (item.text && item.text.length > 200) {
		summary += '...';
	}

	return {
		title: item.title || `HN Item ${itemId}`,
		content: buildMarkdownContent(item),
		summary,
		ogImageUrl: null, // HN doesn't have per-post images
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
