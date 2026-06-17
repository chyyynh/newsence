/**
 * Measure the pixel dimensions of a remote image by reading it through the
 * Cloudflare Images binding (`env.IMAGES.info`).
 *
 * Why this exists: most sources do NOT emit `<meta property="og:image:width">`
 * tags, so `fetchOgImage` can only recover dimensions for the handful that do
 * (Techcrunch, OpenAI, …). The frontend hero + feed card reserve their image
 * box from `platform_metadata.ogImageWidth/Height`; without dims they fall back
 * to a 16:9 placeholder and snap to the real ratio once the image loads. By
 * measuring the actual bytes here we populate dims for ANY source that has an
 * og image, eliminating that snap.
 *
 * `IMAGES.info()` parses the format header (PNG/JPEG/WebP/GIF/AVIF) and returns
 * `{ format, fileSize, width, height }` — no manual magic-byte parsing, no extra
 * dependency. SVGs report only `{ format: 'image/svg+xml' }` (no intrinsic
 * pixels) → we return null, leaving the consumer on its aspect-ratio fallback.
 *
 * Every failure path returns null and never throws: a missing dimension is a
 * cosmetic loss (one layout snap), never worth failing the processing workflow.
 */

import { BROWSER_UA } from '@shared/fetch';
import { logWarn } from '@shared/log';
import type { Env } from '@shared/types';

export interface ImageDimensions {
	width: number;
	height: number;
}

const FETCH_TIMEOUT_MS = 10_000;
// og images are tiny; anything past this is almost certainly not a thumbnail
// we'd want to box around. Skip rather than stream megabytes through info().
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export async function measureImageDimensions(env: Env, imageUrl: string): Promise<ImageDimensions | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(imageUrl, {
			headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*' },
			signal: controller.signal,
		});

		if (!response.ok || !response.body) return null;

		const contentLength = Number(response.headers.get('content-length') ?? 0);
		if (contentLength > MAX_IMAGE_BYTES) {
			response.body.cancel();
			return null;
		}

		const info = await env.IMAGES.info(response.body);
		// SVG (and any future dimension-less format) reports format only.
		if (!('width' in info) || !('height' in info)) return null;
		if (!info.width || !info.height) return null;

		return { width: info.width, height: info.height };
	} catch (err) {
		logWarn('IMAGE_DIMS', 'Failed to measure image dimensions', {
			imageUrl,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	} finally {
		clearTimeout(timer);
	}
}
