import { deleteTempObject, putTempText, readTempBytes, readTempText } from '@shared/r2-temp';
import type { Env } from '@shared/types';
import { type PdfTextStatus, parsePdf } from '../extract';

const TMP_PDF_TEXT_PREFIX = 'tmp/workflow/pdf-text/';

export interface PdfTextTempResult {
	status: PdfTextStatus | 'failed';
	chars: number;
	pages: number;
	textStorageKey?: string;
}

export async function createPdfTextTemp(env: Env, articleId: string, storageKey: string): Promise<PdfTextTempResult> {
	const { bytes } = await readTempBytes(env, storageKey, { label: 'PDF source object' });
	const { text, status, chars, pages } = await parsePdf(bytes);
	const textStorageKey = `${TMP_PDF_TEXT_PREFIX}${articleId}/${crypto.randomUUID()}.md`;
	await putTempText(env, textStorageKey, text, 'text/markdown; charset=utf-8');
	console.info({ tag: 'WORKFLOW', msg: 'PDF extracted', article_id: articleId, status, chars, pages });
	return { status, chars, pages, textStorageKey };
}

export async function readPdfTextTemp(env: Env, textStorageKey: string): Promise<string> {
	return readTempText(env, textStorageKey, { prefix: TMP_PDF_TEXT_PREFIX, label: 'PDF text temp object' });
}

export async function deletePdfTextTemp(env: Env, textStorageKey: string): Promise<void> {
	await deleteTempObject(env, textStorageKey, { prefix: TMP_PDF_TEXT_PREFIX, label: 'PDF text temp object' });
}
