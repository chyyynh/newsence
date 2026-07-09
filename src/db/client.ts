import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import * as schema from './schema';

export type CoreDb = NodePgDatabase<typeof schema>;

export async function withCoreDb<T>(env: CoreEnv, operation: (db: CoreDb, client: Client) => Promise<T>): Promise<T> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	try {
		await client.connect();
		return await operation(drizzle(client, { schema }), client);
	} finally {
		await closeCoreDbClient(client);
	}
}

async function closeCoreDbClient(client: Client): Promise<void> {
	await client.end().catch((error) =>
		console.warn({
			tag: 'DB',
			msg: 'client close failed',
			error: String(error),
		}),
	);
}
