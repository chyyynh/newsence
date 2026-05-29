// Polar usage-event ingestion — bare REST instead of `@polar-sh/sdk` so the
// worker bundle stays small. Wire shape verified against the SDK's compiled
// `funcs/eventsIngest.js` + `EventCreateExternalCustomer$outboundSchema`:
//   POST {server}/v1/events/ingest
//   Authorization: Bearer <POLAR_API_KEY>
//   { events: [{ name, external_customer_id, metadata }] }   ← snake_case
//
// Fire-and-forget and never throws — analytics metering must not affect the
// chat response. No-op when POLAR_API_KEY is unset (e.g. local dev), matching
// the frontend's `ingestToPolar` guard.

import { logError } from '../../infra/log';
import type { Env } from '../../models/types';

const SERVER_URLS = {
	production: 'https://api.polar.sh',
	sandbox: 'https://sandbox-api.polar.sh',
} as const;

type PolarMetadata = Record<string, string | number | boolean>;

export async function ingestPolarEvent(env: Env, name: string, userId: string, metadata: PolarMetadata): Promise<void> {
	const apiKey = env.POLAR_API_KEY;
	if (!apiKey) return;
	const base = env.POLAR_SERVER === 'sandbox' ? SERVER_URLS.sandbox : SERVER_URLS.production;

	try {
		const res = await fetch(`${base}/v1/events/ingest`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ events: [{ name, external_customer_id: userId, metadata }] }),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			logError('POLAR', 'ingest non-2xx', { name, status: res.status, body: text.slice(0, 200) });
		}
	} catch (err) {
		logError('POLAR', 'ingest failed', { name, error: err instanceof Error ? err.message : String(err) });
	}
}
