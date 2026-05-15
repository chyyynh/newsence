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
 * Body: { imageUrl: string, keyPrefix: string }
 *   - keyPrefix: caller-supplied path prefix, e.g. `users/{userId}/uploads/`.
 *     Worker appends `{uuid}.{ext}` derived from the response content-type.
 */

import type { Env } from '../../models/types';
import { parseJsonBody, requireAuth } from '../middleware/auth';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

type RehostBody = {
	imageUrl?: string;
	keyPrefix?: string;
};

class PayloadTooLargeError extends Error {
	constructor() {
		super('Image exceeds 10MB');
		this.name = 'PayloadTooLargeError';
	}
}

function extensionFromContentType(contentType: string): string {
	const subtype = contentType.split('/')[1]?.split(';')[0]?.split('+')[0]?.trim() ?? 'bin';
	return subtype === 'jpeg' ? 'jpg' : subtype;
}

function badRequest(message: string): Response {
	return Response.json({ success: false, error: { code: 'BAD_REQUEST', message } }, { status: 400 });
}

function isRasterImage(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return lower.startsWith('image/') && !lower.startsWith('image/svg');
}

function streamWithByteLimit(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): { stream: ReadableStream<Uint8Array>; getBytesSeen: () => number } {
	let bytesSeen = 0;
	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytesSeen += chunk.byteLength;
				if (bytesSeen > maxBytes) {
					controller.error(new PayloadTooLargeError());
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return { stream, getBytesSeen: () => bytesSeen };
}

function isValidUploadPrefix(keyPrefix: string): boolean {
	return /^users\/[^/]+\/uploads\/$/.test(keyPrefix);
}

export async function handleRehostImage(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const body = await parseJsonBody<RehostBody>(request);
	if (body instanceof Response) return body;

	const imageUrl = body.imageUrl?.trim();
	const keyPrefix = body.keyPrefix?.trim();
	if (!imageUrl) return badRequest('Missing imageUrl');
	if (!keyPrefix) return badRequest('Missing keyPrefix');
	if (!isValidUploadPrefix(keyPrefix)) {
		return badRequest('Invalid keyPrefix');
	}

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
	if (!upstream.body) {
		return Response.json({ success: false, error: { code: 'UPSTREAM_ERROR', message: 'Upstream body is empty' } }, { status: 502 });
	}

	const contentType = upstream.headers.get('content-type')?.split(';')[0].trim() || 'image/png';
	if (!isRasterImage(contentType)) return badRequest('URL must point to a raster image');

	const declaredLength = upstream.headers.get('content-length');
	if (declaredLength && Number.parseInt(declaredLength, 10) > MAX_IMAGE_BYTES) {
		return badRequest('Image exceeds 10MB');
	}

	const key = `${keyPrefix}${crypto.randomUUID()}.${extensionFromContentType(contentType)}`;
	const limited = streamWithByteLimit(upstream.body, MAX_IMAGE_BYTES);
	try {
		await env.R2.put(key, limited.stream, {
			httpMetadata: { contentType, cacheControl: 'private, max-age=31536000' },
		});
	} catch (err) {
		if (err instanceof PayloadTooLargeError || (err instanceof Error && err.name === 'PayloadTooLargeError')) {
			return badRequest('Image exceeds 10MB');
		}
		return Response.json({ success: false, error: { code: 'R2_PUT_FAILED', message: `R2 put failed: ${err}` } }, { status: 502 });
	}

	return Response.json({
		success: true,
		data: {
			key,
			contentType,
			fileSize: limited.getBytesSeen(),
		},
	});
}
