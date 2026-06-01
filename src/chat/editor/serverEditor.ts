// Lexical conversion lives on Vercel (issue: split-chat-worker). The worker
// holds no @lexical deps — these call the frontend's internal conversion
// endpoint (frontend app/api/internal/lexical/route.ts), authed by the shared
// CORE_WORKER_INTERNAL_TOKEN, to convert markdown ↔ the Lexical JSON stored in
// user_documents.content. The worker stays the persister (it still owns the
// transaction / version-guard / workspace logic) — only the pure conversion
// crosses to Vercel, which removes the worker↔frontend serverEditor drift.

import type { Env } from '@shared/types';

async function callLexical<T>(env: Env, body: Record<string, unknown>): Promise<T> {
	const base = env.APP_BASE_URL;
	if (!base) throw new Error('APP_BASE_URL not configured — cannot reach the Lexical conversion endpoint');
	const res = await fetch(`${base}/api/internal/lexical`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.CORE_WORKER_INTERNAL_TOKEN ?? '' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Lexical conversion failed (${res.status})`);
	const json = (await res.json()) as { ok?: boolean; data?: T };
	if (!json.ok || json.data === undefined) throw new Error('Lexical conversion returned no data');
	return json.data;
}

/** markdown → Lexical editor-state JSON (for INSERT/UPDATE into user_documents.content). */
export async function markdownToLexicalJson(env: Env, markdown: string): Promise<object> {
	const { lexical } = await callLexical<{ lexical: object }>(env, { op: 'from-markdown', markdown });
	return lexical;
}

/** DB content (Lexical JSON or legacy string) → markdown, for the model to read/edit. */
export async function contentToMarkdown(env: Env, content: unknown): Promise<string> {
	const { markdown } = await callLexical<{ markdown: string }>(env, { op: 'to-markdown', content });
	return markdown;
}
