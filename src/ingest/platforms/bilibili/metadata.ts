// ─────────────────────────────────────────────────────────────
// Bilibili Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

function now(): string {
	return new Date().toISOString();
}

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
		fetchedAt: now(),
		data,
	};
}
