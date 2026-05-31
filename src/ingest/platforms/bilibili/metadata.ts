// ─────────────────────────────────────────────────────────────
// Bilibili Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

export interface BilibiliMetadata {
	uid: string;
	authorName: string;
	cardType: string;
	dynamicId?: string;
	coverUrl?: string;
}

// ─────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────

export function buildBilibili(data: BilibiliMetadata): { type: 'bilibili'; fetchedAt: string; data: BilibiliMetadata } {
	return {
		type: 'bilibili',
		fetchedAt: new Date().toISOString(),
		data,
	};
}
