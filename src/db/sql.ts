import { type SQL, sql } from 'drizzle-orm';
import type { CoreDb } from './client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function toIsoString(value: Date | string | null): string | undefined {
	if (value === null) return undefined;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
