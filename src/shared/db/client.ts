// Per-request pg client lifecycle. Hyperdrive pools globally — a long-lived
// Client at module scope would leak between requests, so every helper opens
// + ends one per call.

import { Client } from 'pg';
import type { Env } from '../types';

export async function withClient<T>(env: Env, fn: (client: Client) => Promise<T>): Promise<T> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end().catch(() => {});
	}
}

export async function withTx<T>(env: Env, fn: (client: Client) => Promise<T>): Promise<T> {
	return withClient(env, async (client) => {
		await client.query('BEGIN');
		try {
			const result = await fn(client);
			await client.query('COMMIT');
			return result;
		} catch (err) {
			await client.query('ROLLBACK').catch(() => {});
			throw err;
		}
	});
}
