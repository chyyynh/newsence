import { Client } from 'pg';
import type { Env } from '../models/types';
export type DbClient = Client;

export async function createDbClient(env: Env): Promise<Client> {
	const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await client.connect();
	return client;
}

export const ARTICLES_TABLE = 'articles';
export const USER_ARTICLES_TABLE = 'user_articles';
