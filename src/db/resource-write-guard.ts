import { sql } from 'drizzle-orm';
import { type CoreDb, queryRows, withCoreDb } from './client';

export class ResourceWritesFrozenError extends Error {
	readonly cause: unknown;

	constructor(operation: string, cause?: unknown) {
		super(`resource writes are frozen for #251; rejected ${operation}`);
		this.name = 'ResourceWritesFrozenError';
		this.cause = cause;
	}
}

export async function resourceWritesEnabled(env: CoreEnv): Promise<boolean> {
	return withCoreDb(env, resourceWritesEnabledInDb);
}

async function resourceWritesEnabledInDb(db: CoreDb): Promise<boolean> {
	const rows = await queryRows<{ enabled: boolean }>(
		db,
		sql`SELECT to_regclass('migration_guards.resource_writes_251') IS NULL AS enabled`,
	);
	return rows.length === 1 && rows[0]?.enabled === true;
}

export async function assertResourceWritesEnabledInDb(db: CoreDb, operation: string): Promise<void> {
	let enabled = false;
	try {
		enabled = await resourceWritesEnabledInDb(db);
	} catch (error) {
		throw new ResourceWritesFrozenError(`${operation} because the write guard could not be read`, error);
	}
	if (!enabled) throw new ResourceWritesFrozenError(operation);
}

export async function assertResourceWritesEnabled(env: CoreEnv, operation: string): Promise<void> {
	let enabled = false;
	try {
		enabled = await resourceWritesEnabled(env);
	} catch (error) {
		throw new ResourceWritesFrozenError(`${operation} because the write guard could not be read`, error);
	}
	if (!enabled) throw new ResourceWritesFrozenError(operation);
}

export async function shouldDispatchResourceWriters(env: CoreEnv, surface: string): Promise<boolean> {
	try {
		return await resourceWritesEnabled(env);
	} catch (error) {
		console.error({
			tag: 'RESOURCE_WRITE_GUARD',
			event: 'resource_writes_skipped_fail_closed',
			surface,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
