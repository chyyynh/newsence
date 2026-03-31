export const DEFAULT_SUBMIT_RATE_LIMIT_MAX = 20;
export const DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC = 60;

/**
 * Best-effort in-memory rate limiter. NOT reliable across isolates —
 * Cloudflare may route requests to different instances. Acceptable for
 * /submit which is low-traffic and auth-gated. For stricter limiting,
 * migrate to Durable Objects or KV-based counting.
 */
type RateBucket = { count: number; resetAt: number };
const submitRateBuckets = new Map<string, RateBucket>();

export function getSubmitRateKey(request: Request, userId?: string): string {
	const normalizedUserId = userId?.trim();
	if (normalizedUserId) return `user:${normalizedUserId}`;
	const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	return ip ? `ip:${ip}` : 'anon';
}

function pruneExpiredBuckets(): void {
	const now = Date.now();
	for (const [key, bucket] of submitRateBuckets) {
		if (bucket.resetAt <= now) submitRateBuckets.delete(key);
	}
}

export function hitSubmitRateLimit(key: string, max: number, windowSec: number, cost = 1): { limited: boolean; retryAfterSec: number } {
	const now = Date.now();
	const windowMs = Math.max(windowSec, 1) * 1000;
	if (submitRateBuckets.size > 1000) pruneExpiredBuckets();
	const existing = submitRateBuckets.get(key);

	if (!existing || existing.resetAt <= now) {
		if (cost > max) {
			const retryAfterSec = existing ? Math.max(Math.ceil((existing.resetAt - now) / 1000), 1) : Math.max(windowSec, 1);
			return { limited: true, retryAfterSec };
		}
		submitRateBuckets.set(key, { count: cost, resetAt: now + windowMs });
		return { limited: false, retryAfterSec: 0 };
	}

	if (existing.count + cost > max) {
		return { limited: true, retryAfterSec: Math.max(Math.ceil((existing.resetAt - now) / 1000), 1) };
	}

	existing.count += cost;
	submitRateBuckets.set(key, existing);
	return { limited: false, retryAfterSec: 0 };
}
