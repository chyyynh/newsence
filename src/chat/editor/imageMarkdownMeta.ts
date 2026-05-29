// Mirrors frontend/src/lib/editor/imageMarkdownMeta.ts. Custom image
// properties ride through the markdown `title` attribute as `opennews:`-
// prefixed URI-encoded JSON so the roundtrip survives both writers.

type ImageMarkdownMeta = {
	width?: number | null;
	height?: number | null;
	alignment?: 'left' | 'center' | 'right';
	caption?: string;
	showCaption?: boolean;
	isFullWidth?: boolean;
	cropX?: number;
	cropY?: number;
	cropScale?: number;
};

const TITLE_PREFIX = 'opennews:';

function toFiniteNumber(value: unknown): number | undefined {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function encodeImageMarkdownTitle(meta: ImageMarkdownMeta): string | null {
	const compact = {
		w: toFiniteNumber(meta.width),
		h: toFiniteNumber(meta.height),
		a: meta.alignment === 'left' || meta.alignment === 'right' ? meta.alignment : undefined,
		c: meta.caption?.trim() ? meta.caption : undefined,
		sc: meta.showCaption ? 1 : undefined,
		fw: meta.isFullWidth ? 1 : undefined,
		cx: toFiniteNumber(meta.cropX),
		cy: toFiniteNumber(meta.cropY),
		cs: toFiniteNumber(meta.cropScale),
	};
	if (Object.values(compact).every((value) => value === undefined)) return null;
	return `${TITLE_PREFIX}${encodeURIComponent(JSON.stringify(compact))}`;
}

export function decodeImageMarkdownTitle(title: string | null | undefined): ImageMarkdownMeta | null {
	if (!title || !title.startsWith(TITLE_PREFIX)) return null;
	try {
		const decoded = JSON.parse(decodeURIComponent(title.slice(TITLE_PREFIX.length))) as Record<string, unknown>;
		const alignmentRaw = decoded.a;
		const alignment = alignmentRaw === 'left' || alignmentRaw === 'right' || alignmentRaw === 'center' ? alignmentRaw : undefined;

		return {
			width: toFiniteNumber(decoded.w),
			height: toFiniteNumber(decoded.h),
			alignment,
			caption: typeof decoded.c === 'string' ? decoded.c : undefined,
			showCaption: decoded.sc === 1,
			isFullWidth: decoded.fw === 1,
			cropX: toFiniteNumber(decoded.cx),
			cropY: toFiniteNumber(decoded.cy),
			cropScale: toFiniteNumber(decoded.cs),
		};
	} catch {
		return null;
	}
}
