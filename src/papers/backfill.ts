// ─────────────────────────────────────────────────────────────
// Backfill the paper citation graph from already-ingested `paper`
// platform_metadata envelopes (Phase A rows), without re-fetching OpenAlex.
// Reuses syncPaperGraph so the upsert logic has one source of truth.
// ─────────────────────────────────────────────────────────────

import { ARTICLES_TABLE, type ProcessableTable, USER_FILES_TABLE } from '@core-shared/article-store';
import { withDbClient } from '@core-shared/db';
import type { PaperMetadata } from '@core-shared/platform-metadata';
import type { Env } from '@core-shared/types';
import { syncPaperGraph } from './sync';

// user_files stores the envelope in `metadata`; articles in `platform_metadata`.
function metadataColumn(table: ProcessableTable): string {
	return table === USER_FILES_TABLE ? 'metadata' : 'platform_metadata';
}

type PaperBackfillRow = { id: string; meta: unknown };

function paperDataFromEnvelope(meta: unknown): PaperMetadata | null {
	if (!meta || typeof meta !== 'object') return null;
	const envelope = meta as { type?: string; data?: unknown };
	if (envelope.type !== 'paper' || !envelope.data || typeof envelope.data !== 'object') return null;
	const data = envelope.data as PaperMetadata;
	return data.openAlexId ? data : null;
}

export type PaperBackfillResult = {
	table: ProcessableTable;
	scanned: number;
	synced: number;
	edges: number;
	nextCursorId: string | null;
};

/**
 * Promote a page of paper rows into the relational graph. Selects rows whose
 * envelope is a `paper` and that have no `papers.article_id` row yet, ordered by
 * id for keyset pagination. Each row syncs in its own transaction (via
 * syncPaperGraph); a single failure is logged and skipped, not fatal.
 */
export async function backfillPaperGraph(
	env: Env,
	options: { table: ProcessableTable; limit: number; cursorId?: string | null },
): Promise<PaperBackfillResult> {
	const { table, limit } = options;
	const metaCol = metadataColumn(table);
	const rows = await withDbClient(env, (db) =>
		db.query<PaperBackfillRow>(
			`SELECT id, ${metaCol} AS meta
			   FROM ${table}
			  WHERE ${metaCol}->>'type' = 'paper'
			    AND ($2::uuid IS NULL OR id > $2::uuid)
			    AND NOT EXISTS (SELECT 1 FROM papers p WHERE p.article_id = ${table}.id)
			  ORDER BY id ASC
			  LIMIT $1`,
			[limit, options.cursorId ?? null],
		),
	);

	let synced = 0;
	let edges = 0;
	for (const row of rows.rows) {
		const paper = paperDataFromEnvelope(row.meta);
		if (!paper) continue;
		try {
			const summary = await syncPaperGraph(env, row.id, paper);
			if (summary) {
				synced++;
				edges += summary.edges;
			}
		} catch (error) {
			console.warn({ tag: 'PAPER_BACKFILL', msg: 'Row sync failed', id: row.id, error: String(error) });
		}
	}

	const nextCursorId = rows.rows.length === limit ? (rows.rows.at(-1)?.id ?? null) : null;
	return { table, scanned: rows.rows.length, synced, edges, nextCursorId };
}

export function parseBackfillTable(value: unknown): ProcessableTable {
	return value === USER_FILES_TABLE ? USER_FILES_TABLE : ARTICLES_TABLE;
}
