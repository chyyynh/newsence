// ─────────────────────────────────────────────────────────────
// HackerNews Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

export interface HackerNewsMetadata {
	itemId: string;
	author: string;
	points: number;
	commentCount: number;
	itemType?: 'story' | 'ask' | 'show' | 'job';
	storyUrl?: string | null;
}
