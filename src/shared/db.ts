import { Client } from 'pg';
import type { Env } from './types';
export type DbClient = Client;

export async function createDbClient(env: Env): Promise<Client> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return client;
}

export async function withDbClient<T>(env: Env, fn: (db: DbClient) => Promise<T>): Promise<T> {
	const db = await createDbClient(env);
	try {
		return await fn(db);
	} finally {
		await db.end();
	}
}

export async function withDbTransaction<T>(env: Env, rollbackContext: string, fn: (db: DbClient) => Promise<T>): Promise<T> {
	return withDbClient(env, async (db) => {
		try {
			await db.query('BEGIN');
			const result = await fn(db);
			await db.query('COMMIT');
			return result;
		} catch (error) {
			await db
				.query('ROLLBACK')
				.catch((rollbackError) => console.error({ tag: 'DB', msg: `${rollbackContext} rollback failed`, error: String(rollbackError) }));
			throw error;
		}
	});
}
