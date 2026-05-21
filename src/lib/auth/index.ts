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
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import type { Env } from '../../models/types';
import { authSchema } from './schema';

const STATIC_AUTH_OPTIONS = {
	session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
	advanced: { cookiePrefix: 'better-auth' },
} as const;

export interface WorkerSession {
	userId: string;
	sessionId: string;
}

export async function getSession(request: Request, env: Env): Promise<WorkerSession | null> {
	if (!env.BETTER_AUTH_SECRET) {
		throw new Error('BETTER_AUTH_SECRET is required for worker-side auth');
	}

	// Prod: Hyperdrive proxies — its connection string has no ssl* params and
	// needs no client-side SSL config. Local dev (CLOUDFLARE_HYPERDRIVE_LOCAL_*
	// → upstream URL such as PlanetScale) requires SSL; strip URL ssl params
	// because `pg-connection-string` will try `fs.readFileSync(sslrootcert)`
	// which crashes in Workers runtime, and pass `ssl` explicitly instead.
	const rawString = env.HYPERDRIVE.connectionString;
	const needsSsl = /[?&]sslmode=/.test(rawString);
	const connectionString = needsSsl
		? rawString
				.replace(/[?&]ssl[a-z]+=[^&]*/g, '')
				.replace(/\?&/, '?')
				.replace(/\?$/, '')
		: rawString;
	const client = new Client({
		connectionString,
		ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
	});
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
