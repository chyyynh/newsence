// Mirrors frontend/src/lib/editor/versionSnapshot.ts. Same dedup +
// time-throttle semantics so concurrent worker and Vercel snapshot writers
// don't accidentally double-write.

import { withClient } from '@shared/db/client';
import type { Env } from '@shared/types';

type SnapshotSource = 'auto-save' | 'ai-edit' | 'restore';

export interface VersionSnapshotParams {
	documentId: string;
	content: unknown;
	title: string;
	version: number;
	source: SnapshotSource;
}

export interface VersionSnapshotOptions {
	minIntervalMs?: number;
}

export async function createVersionSnapshot(env: Env, params: VersionSnapshotParams, options?: VersionSnapshotOptions): Promise<void> {
	// Stringify once: shape comparison against the latest row and the INSERT
	// param both consume it. Lexical state JSONB can be tens of KB; running
	// JSON.stringify twice per edit is meaningful on the hot path.
	const nextJson = JSON.stringify(params.content);

	await withClient(env, async (client) => {
		const latest = await client.query<{ content: unknown; created_at: Date | string }>(
			`SELECT content, created_at FROM document_versions
			 WHERE document_id = $1
			 ORDER BY created_at DESC
			 LIMIT 1`,
			[params.documentId],
		);
		const row = latest.rows[0];

		if (row && JSON.stringify(row.content) === nextJson) return;

		if (options?.minIntervalMs && row?.created_at) {
			const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
			if (Date.now() - createdAt.getTime() < options.minIntervalMs) return;
		}

		await client.query(
			`INSERT INTO document_versions (document_id, content, title, version, source)
			 VALUES ($1, $2::jsonb, $3, $4, $5)`,
			[params.documentId, nextJson, params.title, params.version, params.source],
		);
	});
}
