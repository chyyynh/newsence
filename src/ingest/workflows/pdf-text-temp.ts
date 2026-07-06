import type { Env } from '@core-shared/types';
import { type PdfTextStatus, parsePdf } from '../extract';

const TMP_PDF_TEXT_PREFIX = 'tmp/workflow/pdf-text/';
const PDF_TEXT_CONTENT_TYPE = 'text/markdown; charset=utf-8';

export interface PdfTextTempResult {
	status: PdfTextStatus | 'failed';
	chars: number;
	pages: number;
	textStorageKey?: string;
}

function assertPdfTextTempKey(key: string): void {
	if (!key.startsWith(TMP_PDF_TEXT_PREFIX)) throw new Error(`Invalid PDF text temp object key: ${key}`);
}

async function readR2Bytes(env: Env, key: string, label: string): Promise<Uint8Array> {
	const obj = await env.R2.get(key);
	if (!obj) throw new Error(`${label} missing: ${key}`);
	return obj.bytes();
}

async function getPdfTextTempObject(env: Env, key: string): Promise<R2ObjectBody> {
	assertPdfTextTempKey(key);
	const obj = await env.R2.get(key);
	if (!obj) throw new Error(`PDF text temp object missing: ${key}`);
	return obj;
}

export async function createPdfTextTemp(env: Env, articleId: string, storageKey: string): Promise<PdfTextTempResult> {
	const bytes = await readR2Bytes(env, storageKey, 'PDF source object');
	const { text, status, chars, pages } = await parsePdf(bytes);
	const textStorageKey = `${TMP_PDF_TEXT_PREFIX}${articleId}/${crypto.randomUUID()}.md`;
	await env.R2.put(textStorageKey, text, { httpMetadata: { contentType: PDF_TEXT_CONTENT_TYPE } });
	console.info({ tag: 'WORKFLOW', msg: 'PDF extracted', article_id: articleId, status, chars, pages });
	return { status, chars, pages, textStorageKey };
}

export async function readPdfTextTemp(env: Env, textStorageKey: string): Promise<string> {
	return (await getPdfTextTempObject(env, textStorageKey)).text();
}

export async function deletePdfTextTemp(env: Env, textStorageKey: string): Promise<void> {
	assertPdfTextTempKey(textStorageKey);
	await env.R2.delete(textStorageKey);
}
