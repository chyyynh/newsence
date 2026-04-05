// ─────────────────────────────────────────────────────────────
// HackerNews Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

function now(): string {
	return new Date().toISOString();
}

export interface HackerNewsMetadata {
	itemId: string;
	author: string;
	points: number;
	commentCount: number;
	itemType?: 'story' | 'ask' | 'show' | 'job';
	storyUrl?: string | null;
}

// ─────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────

export function buildHackerNews(data: HackerNewsMetadata): { type: 'hackernews'; fetchedAt: string; data: HackerNewsMetadata } {
	return {
		type: 'hackernews',
		fetchedAt: now(),
		data,
	};
}
