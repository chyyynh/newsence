// ─────────────────────────────────────────────────────────────
// Paper citation graph sync: promote a `paper` platform_metadata
// envelope into the relational papers / paper_references tables.
//
// Runs in its OWN transaction (via the workflow step), decoupled from article
// persistence — a DOI unique collision here must never poison the article
// insert. Keyed on the OpenAlex work id (every OpenAlex work has one); papers
// without one are skipped (no stable node identity).
// ─────────────────────────────────────────────────────────────

import type { DbClient } from '../db';
import { withDbTransaction } from '../db';
import type { PaperMetadata, PaperReference } from '../platform-metadata';
import type { Env } from '../types';

const MAX_EDGES = 50;

type PaperRow = {
	openAlexId: string;
	doi: string | null;
	articleId: string | null;
	title: string | null;
	authors: string[];
	venue: string | null;
	year: number | null;
	abstract: string | null;
	citedByCount: number | null;
	oaPdfUrl: string | null;
};

/**
 * Upsert a fully-known paper (the ingested one — carries article_id). COALESCE
 * on every field so a node that pre-existed as a reference-only stub gets
 * enriched and linked to its article without clobbering data with nulls.
 */
async function upsertIngestedPaper(db: DbClient, row: PaperRow): Promise<string> {
	const result = await db.query<{ id: string }>(
		`INSERT INTO papers (openalex_id, doi, article_id, title, authors, venue, year, abstract, cited_by_count, oa_pdf_url)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 ON CONFLICT (openalex_id) DO UPDATE SET
		   doi = COALESCE(EXCLUDED.doi, papers.doi),
		   article_id = COALESCE(EXCLUDED.article_id, papers.article_id),
		   title = COALESCE(EXCLUDED.title, papers.title),
		   authors = CASE WHEN cardinality(EXCLUDED.authors) > 0 THEN EXCLUDED.authors ELSE papers.authors END,
		   venue = COALESCE(EXCLUDED.venue, papers.venue),
		   year = COALESCE(EXCLUDED.year, papers.year),
		   abstract = COALESCE(EXCLUDED.abstract, papers.abstract),
		   cited_by_count = COALESCE(EXCLUDED.cited_by_count, papers.cited_by_count),
		   oa_pdf_url = COALESCE(EXCLUDED.oa_pdf_url, papers.oa_pdf_url),
		   updated_at = NOW()
		 RETURNING id`,
		[row.openAlexId, row.doi, row.articleId, row.title, row.authors, row.venue, row.year, row.abstract, row.citedByCount, row.oaPdfUrl],
	);
	const id = result.rows[0]?.id;
	if (!id) throw new Error(`Failed to upsert paper ${row.openAlexId}`);
	return id;
}

/**
 * Upsert a reference-only node. Never touches article_id (a cited work may
 * already be ingested — don't null it out), only backfills title/year when the
 * existing row is missing them.
 */
async function upsertReferenceNode(db: DbClient, ref: PaperReference): Promise<string | null> {
	if (!ref.openAlexId) return null;
	const result = await db.query<{ id: string }>(
		`INSERT INTO papers (openalex_id, doi, title, authors, year)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (openalex_id) DO UPDATE SET
		   doi = COALESCE(EXCLUDED.doi, papers.doi),
		   title = COALESCE(papers.title, EXCLUDED.title),
		   year = COALESCE(papers.year, EXCLUDED.year),
		   updated_at = NOW()
		 RETURNING id`,
		[ref.openAlexId, ref.doi ?? null, ref.title ?? null, ref.author ? [ref.author] : [], ref.year ?? null],
	);
	return result.rows[0]?.id ?? null;
}

/**
 * Sync one ingested paper and its references into the graph. Best-effort: the
 * caller (workflow step) treats a thrown error as non-fatal. Returns a small
 * summary for logging.
 */
export async function syncPaperGraph(env: Env, articleId: string, paper: PaperMetadata): Promise<{ edges: number } | null> {
	if (!paper.openAlexId) return null;

	return withDbTransaction(env, 'paper graph', async (db) => {
		const fromId = await upsertIngestedPaper(db, {
			openAlexId: paper.openAlexId!,
			doi: paper.doi ?? null,
			articleId,
			title: paper.title ?? null,
			authors: paper.authors ?? [],
			venue: paper.venue ?? null,
			year: paper.year ?? null,
			abstract: paper.abstract ?? null,
			citedByCount: paper.citedByCount ?? null,
			oaPdfUrl: paper.oaPdfUrl ?? null,
		});

		const refs = (paper.references ?? []).filter((ref) => ref.openAlexId).slice(0, MAX_EDGES);
		let edges = 0;
		for (let ordinal = 0; ordinal < refs.length; ordinal++) {
			const toId = await upsertReferenceNode(db, refs[ordinal]);
			if (!toId || toId === fromId) continue;
			await db.query(
				`INSERT INTO paper_references (from_paper_id, to_paper_id, ordinal)
				 VALUES ($1, $2, $3) ON CONFLICT (from_paper_id, to_paper_id) DO NOTHING`,
				[fromId, toId, ordinal],
			);
			edges++;
		}
		return { edges };
	});
}
