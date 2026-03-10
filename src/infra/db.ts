import { Client } from 'pg';
import type { Env } from '../models/types';

export type DbClient = Client;

export async function createDbClient(env: Env): Promise<Client> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return client;
}

export function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles';
}
