/**
 * Worker-side better-auth (Phase 3 of #136).
 *
 * Uses the official `better-auth` Drizzle adapter over `node-postgres`
 * (Cloudflare's recommended driver for Hyperdrive — see
 * https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/).
 *
 * Per CF's connection-lifecycle docs, a new `pg.Client` is created per
 * request and ended in `finally`. Hyperdrive already pools connections
 * globally; module-level caching of a Client would leak across request
 * contexts and produce stale-connection errors.
 *
 * We dropped `better-auth-cloudflare` — its value-adds (KV rate limiting,
 * R2 file tracking, geolocation enrichment, IP detection) aren't used here,
 * and its `postgres` field is hard-typed to a `postgres-js` Drizzle instance
 * which would force the worker to ship two DB drivers.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import type { Env } from '../types';
import { authSchema } from './schema';

// Worker chat (#136) auths via `Authorization: Bearer <session.token>` issued
// by Vercel `/api/auth/session-token`. The bearer plugin rewrites that header
// into a synthetic cookie so the rest of better-auth's getSession works
// unchanged. cookieCache is kept on for symmetry with Vercel even though
// bearer requests skip it (cache lives in the cookie itself).
const STATIC_AUTH_OPTIONS = {
	session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
	advanced: { cookiePrefix: 'better-auth' },
	plugins: [bearer()],
};

export interface WorkerSession {
	userId: string;
	sessionId: string;
}

export async function getSession(request: Request, env: Env): Promise<WorkerSession | null> {
	if (!env.BETTER_AUTH_SECRET) {
		throw new Error('BETTER_AUTH_SECRET is required for worker-side auth');
	}

	// Prod Hyperdrive proxies — pg with no ssl config works (matches `infra/db.ts`).
	// Local dev (CLOUDFLARE_HYPERDRIVE_LOCAL_* → upstream URL such as PlanetScale)
	// is currently unsupported here because wrangler dev's `cloudflare:sockets`
	// shim doesn't implement starttls upgrade properly.
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	try {
		const db = drizzle(client, { schema: authSchema });
		const auth = betterAuth({
			...STATIC_AUTH_OPTIONS,
			secret: env.BETTER_AUTH_SECRET,
			database: drizzleAdapter(db, { provider: 'pg', schema: authSchema, usePlural: false }),
		});
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session?.session?.id || !session?.user?.id) return null;
		return { userId: session.user.id, sessionId: session.session.id };
	} catch {
		return null;
	} finally {
		await client.end().catch(() => {});
	}
}
