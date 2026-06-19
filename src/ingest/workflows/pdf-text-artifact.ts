import type { Env } from '@shared/types';
import { type PdfTextStatus, parsePdf } from '../extract';

const TMP_PDF_TEXT_PREFIX = 'tmp/workflow/pdf-text/';

export interface PdfTextArtifactResult {
	status: PdfTextStatus | 'failed';
	chars: number;
	pages: number;
	textStorageKey?: string;
}

export async function createPdfTextArtifact(env: Env, articleId: string, storageKey: string): Promise<PdfTextArtifactResult> {
	const obj = await env.R2.get(storageKey);
	if (!obj) throw new Error(`R2 object missing: ${storageKey}`);

	const { text, status, chars, pages } = await parsePdf(new Uint8Array(await obj.arrayBuffer()));
	const textStorageKey = `${TMP_PDF_TEXT_PREFIX}${articleId}/${crypto.randomUUID()}.md`;
	await env.R2.put(textStorageKey, text, {
		httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
	});
	console.info({ tag: 'WORKFLOW', msg: 'PDF extracted', article_id: articleId, status, chars, pages });
	return { status, chars, pages, textStorageKey };
}

export async function readPdfTextArtifact(env: Env, textStorageKey: string): Promise<string> {
	if (!textStorageKey.startsWith(TMP_PDF_TEXT_PREFIX)) throw new Error(`Invalid PDF text artifact key: ${textStorageKey}`);
	const obj = await env.R2.get(textStorageKey);
	if (!obj) throw new Error(`PDF text artifact missing: ${textStorageKey}`);
	return obj.text();
}

export async function deletePdfTextArtifact(env: Env, textStorageKey: string): Promise<void> {
	if (!textStorageKey.startsWith(TMP_PDF_TEXT_PREFIX)) throw new Error(`Invalid PDF text artifact key: ${textStorageKey}`);
	await env.R2.delete(textStorageKey);
}
