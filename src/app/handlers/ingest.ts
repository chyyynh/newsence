import type { Env } from '../../models/types';
import { parseJsonBody, requireAuth } from '../middleware/auth';
import { getSubmitRateKey } from '../middleware/rate-limit';
import { ingestBlob } from '../use-cases/ingest-blob';
import { submitUrls } from '../use-cases/submit-urls';

type IngestJsonBody = {
	url?: string;
	urls?: string[];
	userId?: string;
};

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
	return Response.json(
		{ success: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: `Unsupported Content-Type: ${contentType || '(none)'}` } },
		{ status: 415 },
	);
}

async function ingestJson(request: Request, env: Env): Promise<Response> {
	const body = await parseJsonBody<IngestJsonBody>(request);
	if (body instanceof Response) return body;

	const urls = body.urls ?? (body.url ? [body.url] : []);
	const outcome = await submitUrls(env, {
		urls,
		userId: body.userId,
		rateKey: getSubmitRateKey(request, body.userId),
	});
	if (outcome.ok) return Response.json({ success: true, results: outcome.results });

	if (outcome.code === 'RATE_LIMITED') {
		return Response.json(
			{ success: false, error: { code: outcome.code, message: outcome.message } },
			{ status: 429, headers: { 'Retry-After': String(outcome.retryAfterSec ?? 1) } },
		);
	}
	const status = outcome.code === 'UNAUTHORIZED' ? 401 : 400;
	return Response.json({ success: false, error: { code: outcome.code, message: outcome.message } }, { status });
}

async function ingestMultipart(request: Request, env: Env): Promise<Response> {
	const outcome = await ingestBlob(request, env);
	if (outcome.ok) return Response.json({ success: true, result: outcome.result });

	const status =
		outcome.code === 'PAYLOAD_TOO_LARGE'
			? 413
			: outcome.code === 'UNSUPPORTED_MEDIA_TYPE'
				? 415
				: outcome.code === 'INTERNAL_ERROR'
					? 500
					: 400;
	return Response.json({ success: false, error: { code: outcome.code, message: outcome.message } }, { status });
}
