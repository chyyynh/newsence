import { parseJsonBody, requireAuth } from '@core-shared/auth';
import { ingestBlob, ingestImageUrl, QUOTA_EXCEEDED_CODE } from '../blob';
import { ingestUrls } from '../urls';

// Matches `simple.period` in `wrangler.jsonc` `ratelimits[USER_INGEST_LIMITER]`.
// Sent as `Retry-After` on 429; the binding doesn't expose remaining time so
// we send the window length as a conservative upper bound.
const RATE_LIMIT_HEADERS = { 'Retry-After': '60' };
const INGEST_ERROR_STATUS: Record<string, number> = {
	UNAUTHORIZED: 401,
	RATE_LIMITED: 429,
	PAYLOAD_TOO_LARGE: 413,
	[QUOTA_EXCEEDED_CODE]: 403,
	UNSUPPORTED_MEDIA_TYPE: 415,
	UPSTREAM_ERROR: 502,
	INTERNAL_ERROR: 500,
};

type IngestJsonBody = {
	urls?: string[];
	imageUrl?: string;
	userId?: string;
	title?: string;
};

function ingestErrorResponse(code: string, message: string): Response {
	return Response.json(
		{ code, message },
		{ status: INGEST_ERROR_STATUS[code] ?? 400, headers: code === 'RATE_LIMITED' ? RATE_LIMIT_HEADERS : undefined },
	);
}

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

			return ingestErrorResponse(outcome.code, outcome.message);
		}

		const outcome = await ingestUrls(env, { urls: body.urls ?? [], userId: body.userId });
		if (outcome.ok) return Response.json(outcome.results);

		return ingestErrorResponse(outcome.code, outcome.message);
	}
	if (contentType.startsWith('multipart/form-data')) {
		const outcome = await ingestBlob(request, env);
		if (outcome.ok) return Response.json(outcome.result);

		return ingestErrorResponse(outcome.code, outcome.message);
	}
	return Response.json(
		{ code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported Content-Type: ${contentType || '(none)'}` },
		{ status: 415 },
	);
}
