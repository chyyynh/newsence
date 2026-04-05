// ─────────────────────────────────────────────────────────────
// Xiaohongshu Platform Metadata Types + Builders
// ─────────────────────────────────────────────────────────────

function now(): string {
	return new Date().toISOString();
}

export interface XiaohongshuMetadata {
	uid: string;
	authorName: string;
	noteId: string;
	coverUrl?: string;
	likeCount?: number;
}

// ─────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────

export function buildXiaohongshu(data: XiaohongshuMetadata): { type: 'xiaohongshu'; fetchedAt: string; data: XiaohongshuMetadata } {
	return {
		type: 'xiaohongshu',
		fetchedAt: now(),
		data,
	};
}
