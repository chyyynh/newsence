import { Client } from 'pg';
export type DbClient = Client;

export async function withDbClient<T>(env: Env, fn: (db: DbClient) => Promise<T>): Promise<T> {
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	return fn(db);
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
