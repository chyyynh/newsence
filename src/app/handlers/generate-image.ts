/**
 * POST /generate-image — call OpenRouter for an AI illustration, store in R2,
 * insert a `user_files` row (originType='generated'). Frontend gates billing
 * around this call; worker is purely the generation+storage primitive.
 *
 * Lives under `users/{userId}/illustrations/` so generated assets stay
 * visually separable from user-curated uploads.
 */

import { storageKeyToAssetUrl } from '../../infra/asset-url';
import { createDbClient, insertBlobUserFile } from '../../infra/db';
import { logError, logInfo } from '../../infra/log';
import { extensionFromMime, isRasterImage, parseBase64DataUrl } from '../../infra/mime';
import { OPENROUTER_CHAT_COMPLETIONS_URL, openRouterHeaders } from '../../infra/openrouter';
import type { Env } from '../../models/types';
import { parseJsonBody, requireAuth } from '../middleware/auth';

// Must stay in sync with `frontend/src/lib/ai/image-generation.ts` IMAGE_MODEL
// — frontend pre-checks billing against the same model name before this runs.
const IMAGE_MODEL = 'google/gemini-3-pro-image-preview';
const MAX_RETRIES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const OPENROUTER_TIMEOUT_MS = 60_000;

interface OpenRouterImageMessage {
	images?: Array<{ image_url?: { url?: string } }>;
}

interface OpenRouterImageResponse {
	choices?: Array<{ message?: OpenRouterImageMessage }>;
	error?: { message?: string };
}

class GenerationError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string,
	) {
		super(message);
	}
}

function errorResponse(status: number, code: string, message: string): Response {
	return Response.json({ success: false, error: { code, message } }, { status });
}

function buildPrompt(description: string): string {
	return `${description}\n\nOutput requirement:\n- 16:9 aspect ratio (landscape orientation)`;
}

async function callOpenRouter(prompt: string, apiKey: string): Promise<OpenRouterImageResponse> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
	let res: Response;
	try {
		res = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
			method: 'POST',
			signal: controller.signal,
			headers: openRouterHeaders(apiKey),
			body: JSON.stringify({
				model: IMAGE_MODEL,
				messages: [{ role: 'user', content: prompt }],
				modalities: ['image', 'text'],
			}),
		});
	} finally {
		clearTimeout(timeoutId);
	}

	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as OpenRouterImageResponse;
		throw new GenerationError(data.error?.message || `OpenRouter API error: ${res.status}`, res.status);
	}
	return res.json() as Promise<OpenRouterImageResponse>;
}

/** Retry on rate limit, 5xx, or network error (fetch threw). */
function isRetryable(err: unknown): boolean {
	if (err instanceof GenerationError) {
		return err.status === 429 || (err.status >= 500 && err.status < 600);
	}
	return err instanceof TypeError;
}

function backoffMs(err: unknown, attempt: number): number {
	if (err instanceof GenerationError && err.status === 429) {
		return Math.min(3 ** attempt * 3000, 20000);
	}
	return 2 ** attempt * 2000;
}

async function callOpenRouterWithRetry(prompt: string, apiKey: string): Promise<OpenRouterImageResponse> {
	let lastError: unknown;
	for (let i = 0; i < MAX_RETRIES; i++) {
		try {
			return await callOpenRouter(prompt, apiKey);
		} catch (err) {
			lastError = err;
			if (i < MAX_RETRIES - 1 && isRetryable(err)) {
				await new Promise((r) => setTimeout(r, backoffMs(err, i)));
				continue;
			}
			break;
		}
	}
	throw lastError instanceof Error ? lastError : new GenerationError('Image generation failed', 500);
}

function extractBase64FromResponse(message: OpenRouterImageMessage | undefined): string {
	const images = message?.images;
	if (!Array.isArray(images) || images.length === 0) {
		throw new GenerationError('No image data in response', 500, 'NO_IMAGE_DATA');
	}
	const url = images[0]?.image_url?.url;
	if (!url) {
		throw new GenerationError('No image URL in response', 500, 'NO_IMAGE_DATA');
	}
	return url;
}

async function generateAndDecode(prompt: string, apiKey: string): Promise<{ bytes: Uint8Array; contentType: string }> {
	const data = await callOpenRouterWithRetry(prompt, apiKey);
	const dataUrl = extractBase64FromResponse(data.choices?.[0]?.message);
	const decoded = parseBase64DataUrl(dataUrl);
	if (!decoded) throw new GenerationError('Invalid base64 data URL from OpenRouter', 500, 'INVALID_IMAGE_DATA');
	return decoded;
}

export async function handleGenerateImage(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const parsed = await parseJsonBody<{ userId?: string; description?: string }>(request);
	if (parsed instanceof Response) return parsed;

	const userId = parsed.userId?.trim() || '';
	const description = parsed.description?.trim() || '';
	if (!userId) return errorResponse(400, 'BAD_REQUEST', 'Missing userId');
	if (!description) return errorResponse(400, 'BAD_REQUEST', 'Missing description');
	if (!env.OPENROUTER_API_KEY) return errorResponse(500, 'CONFIG_ERROR', 'OPENROUTER_API_KEY not configured');

	let decoded: { bytes: Uint8Array; contentType: string };
	try {
		decoded = await generateAndDecode(buildPrompt(description), env.OPENROUTER_API_KEY);
	} catch (err) {
		if (err instanceof GenerationError) {
			logError('GENERATE_IMAGE', 'Generation failed', { status: err.status, code: err.code, message: err.message });
			const httpStatus = err.status >= 400 && err.status < 600 ? err.status : 500;
			return errorResponse(httpStatus, err.code || 'OPENROUTER_ERROR', err.message);
		}
		logError('GENERATE_IMAGE', 'Generation failed (unknown)', { error: String(err) });
		return errorResponse(500, 'OPENROUTER_ERROR', 'Image generation failed');
	}

	const fileType = decoded.contentType;
	const fileSize = decoded.bytes.byteLength;
	if (fileSize > MAX_FILE_BYTES) return errorResponse(413, 'PAYLOAD_TOO_LARGE', 'Generated image exceeds 10MB');
	if (!isRasterImage(fileType)) return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported image type: ${fileType}`);

	const extension = extensionFromMime(fileType);
	const storageKey = `users/${userId}/illustrations/${crypto.randomUUID()}.${extension}`;

	try {
		await env.R2.put(storageKey, decoded.bytes, {
			httpMetadata: { contentType: fileType, cacheControl: 'private, max-age=31536000' },
		});
	} catch (err) {
		logError('GENERATE_IMAGE', 'R2 put failed', { storageKey, error: String(err) });
		return errorResponse(500, 'INTERNAL_ERROR', 'R2 put failed');
	}

	const title = description.slice(0, 200);
	const db = await createDbClient(env);
	let userFileId: string;
	try {
		const row = await insertBlobUserFile(db, {
			userId,
			storageKey,
			fileSize,
			fileType,
			fileName: storageKey.split('/').pop() ?? storageKey,
			originType: 'generated',
			title,
		});
		userFileId = row.id;
	} catch (err) {
		logError('GENERATE_IMAGE', 'DB insert failed', { storageKey, error: String(err) });
		await env.R2.delete(storageKey).catch((delErr) =>
			logError('GENERATE_IMAGE', 'R2 cleanup after DB failure also failed', { storageKey, error: String(delErr) }),
		);
		return errorResponse(500, 'INTERNAL_ERROR', 'DB insert failed');
	} finally {
		await db.end();
	}

	logInfo('GENERATE_IMAGE', 'Generated image stored', { userFileId, storageKey, fileType, fileSize });

	return Response.json({
		success: true,
		result: { userFileId, storageKey, assetUrl: storageKeyToAssetUrl(storageKey), fileType, fileSize },
	});
}
