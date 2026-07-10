import { type SQL, sql } from 'drizzle-orm';

export function textArraySql(values: readonly string[]): SQL {
	return sql`ARRAY[${sql.join(
		values.map((value) => sql`${value}`),
		sql`, `,
	)}]::text[]`;
}
