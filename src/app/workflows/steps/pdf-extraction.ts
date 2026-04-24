import { createDbClient, USER_FILES_TABLE } from '../../../infra/db';
import { logInfo } from '../../../infra/log';
import type { Article, Env } from '../../../models/types';

export function isUploadedPdf(article: Article): boolean {
	return article.origin_type === 'upload' && article.file_type === 'application/pdf' && !!article.storage_key;
}

export async function extractAndPersistPdf(env: Env, articleId: string, storageKey: string): Promise<string> {
	const obj = await env.R2.get(storageKey);
	if (!obj) throw new Error(`R2 object missing: ${storageKey}`);
	const md = await env.AI.toMarkdown({
		name: storageKey.split('/').pop() ?? storageKey,
		blob: new Blob([await obj.arrayBuffer()], { type: 'application/pdf' }),
	});
	if (md.format === 'error') throw new Error(md.error);
	if (!md.data) throw new Error('PDF extraction returned empty markdown');

	const db = await createDbClient(env);
	try {
		await db.query(`UPDATE ${USER_FILES_TABLE} SET extracted_text = $1 WHERE id = $2`, [md.data, articleId]);
	} finally {
		await db.end();
	}
	logInfo('WORKFLOW', 'PDF extracted', { article_id: articleId, tokens: md.tokens, chars: md.data.length });
	return md.data;
}
