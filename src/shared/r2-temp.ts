import { extensionFromMime } from './mime';
import type { Env } from './types';

const SCRAPE_INPUT_TEMP_PREFIX = 'tmp/scrape/';

export function isScrapeInputTempKey(key: string): boolean {
	return key.startsWith(SCRAPE_INPUT_TEMP_PREFIX);
}

function assertScrapeInputTempKey(key: string): void {
	if (!isScrapeInputTempKey(key)) throw new Error(`Invalid scrape input temp object key: ${key}`);
}

async function getScrapeInputTempObject(env: Env, key: string): Promise<R2ObjectBody> {
	assertScrapeInputTempKey(key);
	const obj = await env.R2.get(key);
	if (!obj) throw new Error(`scrape input temp object missing: ${key}`);
	return obj;
}

export async function putScrapeInputTemp(env: Env, bytes: Uint8Array, contentType: string): Promise<{ kind: 'r2'; key: string }> {
	const key = `${SCRAPE_INPUT_TEMP_PREFIX}${crypto.randomUUID()}.${extensionFromMime(contentType)}`;
	await env.R2.put(key, bytes, { httpMetadata: { contentType } });
	return { kind: 'r2', key };
}

export async function readScrapeInputTemp(env: Env, key: string): Promise<{ bytes: Uint8Array; contentType?: string }> {
	const obj = await getScrapeInputTempObject(env, key);
	return {
		bytes: await obj.bytes(),
		contentType: obj.httpMetadata?.contentType,
	};
}

export async function deleteScrapeInputTemp(env: Env, key: string): Promise<void> {
	assertScrapeInputTempKey(key);
	await env.R2.delete(key);
}
