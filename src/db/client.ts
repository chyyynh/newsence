import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import * as schema from './schema';

export type CoreDb = NodePgDatabase<typeof schema>;

type CoreDbOperation<T> = (db: CoreDb, client: Client) => Promise<T>;

export async function withCoreDb<T>(env: CoreEnv, operation: CoreDbOperation<T>): Promise<T> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	try {
		await client.connect();
		return await operation(createCoreDb(client), client);
	} finally {
		await closeCoreDbClient(client);
	}
}

export async function withCoreTx<T>(env: CoreEnv, operation: CoreDbOperation<T>): Promise<T> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	try {
		await client.connect();
		await client.query('BEGIN');
		try {
			const result = await operation(createCoreDb(client), client);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await rollbackCoreDbClient(client);
			throw error;
		}
	} finally {
		await closeCoreDbClient(client);
	}
}

function createCoreDb(client: Client): CoreDb {
	return drizzle(client, { schema });
}

async function rollbackCoreDbClient(client: Client): Promise<void> {
	await client.query('ROLLBACK').catch((error) =>
		console.error({
			tag: 'DB',
			msg: 'transaction rollback failed',
			error: String(error),
		}),
	);
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
