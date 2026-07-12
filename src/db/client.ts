import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import * as schema from './schema';

export type CoreDb = NodePgDatabase<typeof schema>;

type CoreDbOperation<T> = (db: CoreDb, client: Client) => Promise<T>;
type CoreDbOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function withCoreDb<T>(env: CoreEnv, operation: CoreDbOperation<T>): Promise<T> {
	return withCoreDbClient(env, operation);
}

export async function withCoreTx<T>(env: CoreEnv, operation: CoreDbOperation<T>): Promise<T> {
	return withCoreDbClient(env, async (db, client) => {
		await client.query('BEGIN');
		try {
			const result = await operation(db, client);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			try {
				await client.query('ROLLBACK');
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], 'Database transaction and rollback both failed');
			}
			throw error;
		}
	});
}

async function withCoreDbClient<T>(env: CoreEnv, operation: CoreDbOperation<T>): Promise<T> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	let outcome: CoreDbOutcome<T>;
	try {
		await client.connect();
		outcome = { ok: true, value: await operation(createCoreDb(client), client) };
	} catch (error) {
		outcome = { ok: false, error };
	}
	try {
		await client.end();
	} catch (closeError) {
		if (!outcome.ok) throw new AggregateError([outcome.error, closeError], 'Database operation and client close both failed');
		throw closeError;
	}
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

function createCoreDb(client: Client): CoreDb {
	return drizzle(client, { schema });
}
