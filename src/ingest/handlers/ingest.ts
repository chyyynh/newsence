import { parseJsonBody, requireAuth } from '@core-shared/auth';
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
			return Response.json({ code: 'BAD_REQUEST', message: 'Provide imageUrl OR urls, not both' }, { status: 400 });
		}

		if (hasImageUrl) {
			const outcome = await ingestImageUrl(env, {
				imageUrl: body.imageUrl as string,
				userId: body.userId,
				title: body.title ?? null,
			});
			if (outcome.ok) return Response.json(outcome.result);

			return outcome.code === 'RATE_LIMITED'
				? Response.json({ code: outcome.code, message: outcome.message }, { status: 429, headers: RATE_LIMIT_HEADERS })
				: Response.json({ code: outcome.code, message: outcome.message }, { status: IMAGE_URL_ERROR_STATUS[outcome.code] ?? 400 });
		}

		const outcome = await ingestUrls(env, { urls: body.urls ?? [], userId: body.userId });
		if (outcome.ok) return Response.json(outcome.results);

		if (outcome.code === 'RATE_LIMITED') {
			return Response.json({ code: outcome.code, message: outcome.message }, { status: 429, headers: RATE_LIMIT_HEADERS });
		}
		const status = outcome.code === 'UNAUTHORIZED' ? 401 : 400;
		return Response.json({ code: outcome.code, message: outcome.message }, { status });
	}
	if (contentType.startsWith('multipart/form-data')) {
		const outcome = await ingestBlob(request, env);
		if (outcome.ok) return Response.json(outcome.result);

		if (outcome.code === 'RATE_LIMITED') {
			return Response.json({ code: outcome.code, message: outcome.message }, { status: 429, headers: RATE_LIMIT_HEADERS });
		}
		return Response.json({ code: outcome.code, message: outcome.message }, { status: BLOB_ERROR_STATUS[outcome.code] ?? 400 });
	}
	return Response.json(
		{ code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported Content-Type: ${contentType || '(none)'}` },
		{ status: 415 },
	);
}
