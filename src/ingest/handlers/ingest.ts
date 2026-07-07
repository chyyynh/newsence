import { jsonData, jsonError, parseJsonBody, requireAuth } from '@core-shared/auth';
import type { Env } from '@core-shared/types';
import { type IngestImageUrlErrorCode, ingestBlob, ingestImageUrl, QUOTA_EXCEEDED_CODE } from '../blob';
import { ingestUrls } from '../urls';

// Matches `simple.period` in `wrangler.jsonc` `ratelimits[USER_INGEST_LIMITER]`.
// Sent as `Retry-After` on 429; the binding doesn't expose remaining time so
// we send the window length as a conservative upper bound.
const RATE_LIMIT_HEADERS = { 'Retry-After': '60' };
const IMAGE_URL_ERROR_STATUS: Partial<Record<IngestImageUrlErrorCode, number>> = {
	UNAUTHORIZED: 401,
	RATE_LIMITED: 429,
	PAYLOAD_TOO_LARGE: 413,
	[QUOTA_EXCEEDED_CODE]: 403,
	UNSUPPORTED_MEDIA_TYPE: 415,
	UPSTREAM_ERROR: 502,
	INTERNAL_ERROR: 500,
};
const BLOB_ERROR_STATUS: Record<string, number> = {
	RATE_LIMITED: 429,
	PAYLOAD_TOO_LARGE: 413,
	[QUOTA_EXCEEDED_CODE]: 403,
	UNSUPPORTED_MEDIA_TYPE: 415,
	INTERNAL_ERROR: 500,
};

type IngestJsonBody = {
	urls?: string[];
	imageUrl?: string;
	userId?: string;
	title?: string;
};

export async function handleIngest(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';

	if (contentType.startsWith('application/json')) {
		const body = await parseJsonBody<IngestJsonBody>(request);
		if (body instanceof Response) return body;

		const hasImageUrl = typeof body.imageUrl === 'string' && body.imageUrl.trim().length > 0;
		const hasUrlField = Array.isArray(body.urls) && body.urls.length > 0;
		if (hasImageUrl && hasUrlField) {
			return jsonError('BAD_REQUEST', 'Provide imageUrl OR urls, not both', 400);
		}

		if (hasImageUrl) {
			const outcome = await ingestImageUrl(env, {
				imageUrl: body.imageUrl as string,
				userId: body.userId,
				title: body.title ?? null,
			});
			if (outcome.ok) return jsonData(outcome.result);

			return outcome.code === 'RATE_LIMITED'
				? jsonError(outcome.code, outcome.message, 429, RATE_LIMIT_HEADERS)
				: jsonError(outcome.code, outcome.message, IMAGE_URL_ERROR_STATUS[outcome.code] ?? 400);
		}

		const outcome = await ingestUrls(env, { urls: body.urls ?? [], userId: body.userId });
		if (outcome.ok) return jsonData(outcome.results);

		if (outcome.code === 'RATE_LIMITED') {
			return jsonError(outcome.code, outcome.message, 429, RATE_LIMIT_HEADERS);
		}
		const status = outcome.code === 'UNAUTHORIZED' ? 401 : 400;
		return jsonError(outcome.code, outcome.message, status);
	}
	if (contentType.startsWith('multipart/form-data')) {
		const outcome = await ingestBlob(request, env);
		if (outcome.ok) return jsonData(outcome.result);

		if (outcome.code === 'RATE_LIMITED') {
			return jsonError(outcome.code, outcome.message, 429, RATE_LIMIT_HEADERS);
		}
		return jsonError(outcome.code, outcome.message, BLOB_ERROR_STATUS[outcome.code] ?? 400);
	}
	return jsonError('UNSUPPORTED_MEDIA_TYPE', `Unsupported Content-Type: ${contentType || '(none)'}`, 415);
}
