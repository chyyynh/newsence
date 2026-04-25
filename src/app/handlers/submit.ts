import type { Env } from '../../models/types';
import { parseJsonBody, requireAuth } from '../middleware/auth';
import { getSubmitRateKey } from '../middleware/rate-limit';
import { submitUrls } from '../use-cases/submit-urls';

type SubmitBody = {
	url?: string; // Legacy single URL
	urls?: string[]; // Batch URLs
	userId?: string;
	visibility?: 'public' | 'private';
};

export async function handleSubmitUrl(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	const body = await parseJsonBody<SubmitBody>(request);
	if (body instanceof Response) return body;

	const urls = body.urls ?? (body.url ? [body.url] : []);
	const outcome = await submitUrls(env, {
		urls,
		userId: body.userId,
		visibility: body.visibility,
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
