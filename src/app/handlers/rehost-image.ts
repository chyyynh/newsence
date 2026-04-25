/**
 * POST /rehost-image — fetch a user-supplied image URL and store it in R2.
 *
 * Lives in the worker (not Vercel) because Cloudflare's Workers runtime cannot
 * reach private/loopback/cloud-metadata IPs from within `fetch()` — the SSRF
 * blast radius collapses to "the public internet only." That removes the need
 * for application-level IP allowlisting / DNS-rebinding defenses we'd otherwise
 * need on a Node/Vercel host.
 *
 * Auth: internal token (same as /submit).
 * Body: { imageUrl: string, filename: string }
 *   - filename is the R2 object name suffix (frontend generates it for naming
 *     consistency with the /api/upload PDF + base64 paths).
 */

import type { Env } from '../../models/types';
import { parseJsonBody, requireAuth } from '../middleware/auth';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

type RehostBody = {
	imageUrl?: string;
	filename?: string;
};

function badRequest(message: string): Response {
	return Response.json({ success: false, error: { code: 'BAD_REQUEST', message } }, { status: 400 });
}

function isRasterImage(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return lower.startsWith('image/') && !lower.startsWith('image/svg');
}

export async function handleRehostImage(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const body = await parseJsonBody<RehostBody>(request);
	if (body instanceof Response) return body;

	const imageUrl = body.imageUrl?.trim();
	const filename = body.filename?.trim();
	if (!imageUrl) return badRequest('Missing imageUrl');
	if (!filename) return badRequest('Missing filename');

	let parsed: URL;
	try {
		parsed = new URL(imageUrl);
	} catch {
		return badRequest('Invalid image URL');
	}
	if (parsed.protocol !== 'https:') return badRequest('Image URL must use HTTPS');
	if (parsed.username || parsed.password) return badRequest('Image URL must not include credentials');

	let upstream: Response;
	try {
		upstream = await fetch(parsed.toString(), { redirect: 'follow' });
	} catch (err) {
		return Response.json({ success: false, error: { code: 'FETCH_FAILED', message: `Fetch failed: ${err}` } }, { status: 502 });
	}
	if (!upstream.ok) {
		return Response.json(
			{ success: false, error: { code: 'UPSTREAM_ERROR', message: `Upstream returned ${upstream.status}` } },
			{ status: 502 },
		);
	}

	const contentType = upstream.headers.get('content-type')?.split(';')[0].trim() || 'image/png';
	if (!isRasterImage(contentType)) return badRequest('URL must point to a raster image');

	const declaredLength = upstream.headers.get('content-length');
	if (declaredLength && Number.parseInt(declaredLength, 10) > MAX_IMAGE_BYTES) {
		return badRequest('Image exceeds 10MB');
	}

	const buffer = await upstream.arrayBuffer();
	if (buffer.byteLength > MAX_IMAGE_BYTES) return badRequest('Image exceeds 10MB');

	const key = `images/${Date.now()}-${filename}`;
	await env.R2.put(key, buffer, {
		httpMetadata: { contentType, cacheControl: 'private, max-age=31536000' },
	});

	return Response.json({
		success: true,
		data: {
			key,
			contentType,
			fileSize: buffer.byteLength,
		},
	});
}
