import { parseJsonBody, requireAuth } from '@shared/auth';
import type { Env } from '@shared/types';
import { type IngestImageUrlErrorCode, ingestBlob, ingestImageUrl } from '../blob';
import { ingestUrls } from '../urls';

// Matches `simple.period` in `wrangler.jsonc` `ratelimits[USER_INGEST_LIMITER]`.
// Sent as `Retry-After` on 429; the binding doesn't expose remaining time so
// we send the window length as a conservative upper bound.
const RATE_LIMIT_PERIOD_SEC = 60;

type IngestJsonBody = {
	url?: string;
	urls?: string[];
	imageUrl?: string;
	userId?: string;
	title?: string;
};

function ingestError(code: string, message: string, status: number, headers?: HeadersInit): Response {
	return Response.json({ success: false, error: { code, message } }, { status, headers });
}

function ingestResult<T>(result: T): Response {
	return Response.json({ success: true, result });
}

function ingestResults<T>(results: T[]): Response {
	return Response.json({ success: true, results });
}

function rateLimited(code: string, message: string): Response {
	return ingestError(code, message, 429, { 'Retry-After': String(RATE_LIMIT_PERIOD_SEC) });
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';

	if (contentType.startsWith('application/json')) {
		return ingestJson(request, env);
	}
	if (contentType.startsWith('multipart/form-data')) {
		return ingestMultipart(request, env);
	}
	return ingestError('UNSUPPORTED_MEDIA_TYPE', `Unsupported Content-Type: ${contentType || '(none)'}`, 415);
}

async function ingestJson(request: Request, env: Env): Promise<Response> {
	const body = await parseJsonBody<IngestJsonBody>(request);
	if (body instanceof Response) return body;

	const hasImageUrl = typeof body.imageUrl === 'string' && body.imageUrl.trim().length > 0;
	const hasUrlField = (typeof body.url === 'string' && body.url.trim().length > 0) || (Array.isArray(body.urls) && body.urls.length > 0);
	if (hasImageUrl && hasUrlField) {
		return ingestError('BAD_REQUEST', 'Provide imageUrl OR url/urls, not both', 400);
	}

	if (hasImageUrl) {
		return ingestImageUrlJson(body, env);
	}
	return ingestUrlsJson(body, env);
}

async function ingestImageUrlJson(body: IngestJsonBody, env: Env): Promise<Response> {
	const outcome = await ingestImageUrl(env, {
		imageUrl: body.imageUrl as string,
		userId: body.userId,
		title: body.title ?? null,
	});
	if (outcome.ok) return ingestResult(outcome.result);

	const status = imageUrlStatusFor(outcome.code);
	return outcome.code === 'RATE_LIMITED' ? rateLimited(outcome.code, outcome.message) : ingestError(outcome.code, outcome.message, status);
}

function imageUrlStatusFor(code: IngestImageUrlErrorCode): number {
	switch (code) {
		case 'UNAUTHORIZED':
			return 401;
		case 'RATE_LIMITED':
			return 429;
		case 'PAYLOAD_TOO_LARGE':
			return 413;
		case 'QUOTA_EXCEEDED':
			return 403;
		case 'UNSUPPORTED_MEDIA_TYPE':
			return 415;
		case 'UPSTREAM_ERROR':
			return 502;
		case 'INTERNAL_ERROR':
			return 500;
		default:
			return 400;
	}
}

async function ingestUrlsJson(body: IngestJsonBody, env: Env): Promise<Response> {
	const urls = body.urls ?? (body.url ? [body.url] : []);
	const outcome = await ingestUrls(env, { urls, userId: body.userId });
	if (outcome.ok) return ingestResults(outcome.results);

	if (outcome.code === 'RATE_LIMITED') {
		return rateLimited(outcome.code, outcome.message);
	}
	const status = outcome.code === 'UNAUTHORIZED' ? 401 : 400;
	return ingestError(outcome.code, outcome.message, status);
}

async function ingestMultipart(request: Request, env: Env): Promise<Response> {
	const outcome = await ingestBlob(request, env);
	if (outcome.ok) return ingestResult(outcome.result);

	if (outcome.code === 'RATE_LIMITED') {
		return rateLimited(outcome.code, outcome.message);
	}
	const status =
		outcome.code === 'PAYLOAD_TOO_LARGE'
			? 413
			: outcome.code === 'QUOTA_EXCEEDED'
				? 403
				: outcome.code === 'UNSUPPORTED_MEDIA_TYPE'
					? 415
					: outcome.code === 'INTERNAL_ERROR'
						? 500
						: 400;
	return ingestError(outcome.code, outcome.message, status);
}
