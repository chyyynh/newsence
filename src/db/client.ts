import type { ResourceContentSurface } from '@core-shared/resource-types';
import { type SQL, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import * as schema from './schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CoreDb = NodePgDatabase<typeof schema>;

type CoreDbOperation<T> = (db: CoreDb, client: Client) => Promise<T>;

export function isValidUuid(value: string): boolean {
	return UUID_RE.test(value);
}

export function textArraySql(values: readonly string[]): SQL {
	return sql`ARRAY[${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	)}]::text[]`;
}

export function uuidArraySql(values: readonly string[]): SQL {
	return sql`ARRAY[${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	)}]::uuid[]`;
}

export async function queryRows<T>(db: CoreDb, statement: SQL): Promise<T[]> {
	const result = await db.execute(statement);
	return result.rows as T[];
}

export function resourceContentAccessSql(surface: ResourceContentSurface, input: { viewerHasOwnership: SQL; scope: SQL }): SQL {
	return surface === 'app' ? sql`(${input.scope} = 'corpus' OR ${input.viewerHasOwnership})` : input.viewerHasOwnership;
}

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
