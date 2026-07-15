import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import * as schema from './schema';

export type CoreDb = NodePgDatabase<typeof schema>;

type CoreDbOperation<T> = (db: CoreDb, client: Client) => Promise<T>;

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
	// Keep the edge client scoped to this invocation. Hyperdrive owns the
	// underlying origin pool and automatically cleans up the edge connection
	// when the request, Workflow, Queue consumer, or Durable Object ends.
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return operation(createCoreDb(client), client);
}

function createCoreDb(client: Client): CoreDb {
	return drizzle(client, { schema });
}
