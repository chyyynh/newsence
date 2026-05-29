// MIRROR OF frontend/src/lib/tracking/posthog-server.ts event shape.
// Uses bare PostHog capture REST API instead of posthog-node so the worker
// bundle stays small and avoids the SDK's Node-specific deps.
// https://posthog.com/docs/api/capture

import { logError } from '@shared/log';
import type { Env } from '@shared/types';

const DEFAULT_HOST = 'https://us.i.posthog.com';

interface CaptureInput {
	distinctId: string;
	event: string;
	properties: Record<string, unknown>;
}

export async function capturePostHogEvent(env: Env, input: CaptureInput): Promise<void> {
	const apiKey = env.POSTHOG_API_KEY;
	if (!apiKey) return; // Silent no-op when not configured (e.g. local dev).
	const host = env.POSTHOG_HOST || DEFAULT_HOST;

	try {
		const res = await fetch(`${host.replace(/\/$/, '')}/capture/`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				api_key: apiKey,
				event: input.event,
				distinct_id: input.distinctId,
				properties: input.properties,
				timestamp: new Date().toISOString(),
			}),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			logError('POSTHOG', 'capture non-2xx', { event: input.event, status: res.status, body: text.slice(0, 200) });
		}
	} catch (err) {
		// Analytics must never throw out of waitUntil — swallow + log.
		logError('POSTHOG', 'capture failed', {
			event: input.event,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
