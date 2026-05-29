// Mirrors frontend/src/lib/ai/tools/edit-document.ts. Pure str_replace —
// no AI call inside the tool itself. First edit per document writes a
// pre-edit snapshot so the user can roll back through the existing
// document_versions history.

import { withClient } from '@shared/db/client';
import type { Env } from '@shared/types';
import type { ToolExecutionOptions } from 'ai';
import { tool } from 'ai';
import { z } from 'zod';
import { contentToMarkdown, markdownToLexicalJson } from '../editor/serverEditor';
import { createVersionSnapshot } from '../editor/versionSnapshot';
import type { DataPartWriter } from './registry';

const editDocumentSchema = z.object({
	documentId: z.string().describe('ID of the document to edit'),
	edits: z
		.array(
			z.object({
				old_string: z.string().min(1, 'old_string must not be empty').describe('Exact text to find'),
				new_string: z.string().describe('Replacement text (empty string to delete)'),
			}),
		)
		.min(1)
		.describe('List of str_replace edits to apply sequentially'),
});

type EditDocumentInput = z.output<typeof editDocumentSchema>;

export type EditDocumentResult = { editCount: number };

interface DocRecord {
	id: string;
	title: string;
	content: unknown;
	version: number;
	markdown: string;
}

export function createEditDocumentTool(env: Env, userId: string, writer?: DataPartWriter) {
	const snapshotted = new Set<string>();

	return tool({
		description:
			'Edit an existing document by applying str_replace operations on its Markdown content. ' +
			'Each edit finds an exact text match and replaces it. Use empty new_string to delete text. ' +
			'Always use read-context to read the document content before the first edit.',
		inputSchema: editDocumentSchema,
		execute: async (input: EditDocumentInput, options: ToolExecutionOptions): Promise<EditDocumentResult> => {
			const doc = await fetchDocument(env, input.documentId, userId);
			const { result, applied, failedAt } = applyEdits(doc.markdown, input.edits);
			if (failedAt !== undefined) {
				throw new Error(`Text to replace not found: "${failedAt.slice(0, 60)}"`);
			}

			if (!snapshotted.has(doc.id)) {
				snapshotted.add(doc.id);
				// Await the pre-edit snapshot so it's durably written within the
				// request lifetime — tools have no `ExecutionContext`, so a
				// fire-and-forget INSERT can be lost if the isolate is torn down
				// right after the stream closes. Best-effort: a snapshot failure is
				// logged but doesn't block the edit (matches prior intent).
				await createVersionSnapshot(env, {
					documentId: doc.id,
					content: doc.content,
					title: doc.title,
					version: doc.version,
					source: 'ai-edit',
				}).catch((err) => console.error('[edit-document] snapshot failed:', err));
			}

			const lexicalJson = markdownToLexicalJson(result);
			const newVersion = doc.version + 1;

			await withClient(env, async (client) => {
				// Scope by `user_id` (defense-in-depth on top of the ownership check
				// in `fetchDocument`) and guard on the version we read, so a
				// concurrent write (another tool call or Vercel auto-save) can't be
				// silently clobbered. A 0-row result means the doc changed under us.
				const res = await client.query(
					`UPDATE user_documents
					 SET content = $1::jsonb, version = $2, updated_at = NOW()
					 WHERE id = $3 AND user_id = $4 AND version = $5`,
					[JSON.stringify(lexicalJson), newVersion, input.documentId, userId, doc.version],
				);
				if (res.rowCount === 0) {
					throw new Error(
						'Document was modified since it was read (version conflict). Re-read it with read-context, then re-apply your edits.',
					);
				}
			});

			writer?.write({
				type: 'data-document-edited',
				data: {
					documentId: input.documentId,
					title: doc.title,
					toolCallId: options.toolCallId,
					editCount: applied,
					edits: input.edits,
					newMarkdown: result,
					newVersion,
				},
			});

			return { editCount: applied };
		},
	});
}

async function fetchDocument(env: Env, docId: string, userId: string): Promise<DocRecord> {
	return withClient(env, async (client) => {
		const result = await client.query<{ id: string; title: string | null; content: unknown; version: number }>(
			`SELECT id, title, content, version FROM user_documents WHERE id = $1 AND user_id = $2 LIMIT 1`,
			[docId, userId],
		);
		const row = result.rows[0];
		if (!row) throw new Error('Document not found or access denied');
		return {
			id: row.id,
			title: row.title ?? '',
			content: row.content,
			version: row.version,
			markdown: contentToMarkdown(row.content),
		};
	});
}

function applyEdits(content: string, edits: EditDocumentInput['edits']): { result: string; applied: number; failedAt?: string } {
	let current = content;
	let applied = 0;
	for (const edit of edits) {
		const first = current.indexOf(edit.old_string);
		if (first === -1) {
			return { result: current, applied, failedAt: edit.old_string };
		}
		if (current.indexOf(edit.old_string, first + edit.old_string.length) !== -1) {
			return { result: current, applied, failedAt: `[multiple matches] ${edit.old_string}` };
		}
		current = current.slice(0, first) + edit.new_string + current.slice(first + edit.old_string.length);
		applied++;
	}
	return { result: current, applied };
}
