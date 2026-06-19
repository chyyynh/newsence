import { extensionFromMime } from './mime';
import type { Env } from './types';

type TempObjectGuard = {
	prefix?: string;
	label: string;
};

const SCRAPE_INPUT_TEMP_PREFIX = 'tmp/scrape/';

function assertTempObjectKey(key: string, guard: TempObjectGuard): void {
	if (guard.prefix && !key.startsWith(guard.prefix)) {
		throw new Error(`Invalid ${guard.label} key: ${key}`);
	}
}

export async function putTempText(env: Env, key: string, text: string, contentType: string): Promise<void> {
	await env.R2.put(key, text, {
		httpMetadata: { contentType },
	});
}

export async function putTempBytes(env: Env, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
	await env.R2.put(key, bytes, {
		httpMetadata: { contentType },
	});
}

export async function readTempText(env: Env, key: string, guard: TempObjectGuard): Promise<string> {
	assertTempObjectKey(key, guard);
	const obj = await env.R2.get(key);
	if (!obj) throw new Error(`${guard.label} missing: ${key}`);
	return obj.text();
}

export async function readTempBytes(env: Env, key: string, guard: TempObjectGuard): Promise<{ bytes: Uint8Array; contentType?: string }> {
	assertTempObjectKey(key, guard);
	const obj = await env.R2.get(key);
	if (!obj) throw new Error(`${guard.label} missing: ${key}`);
	return {
		bytes: new Uint8Array(await obj.arrayBuffer()),
		contentType: obj.httpMetadata?.contentType,
	};
}

export async function deleteTempObject(env: Env, key: string, guard: TempObjectGuard): Promise<void> {
	assertTempObjectKey(key, guard);
	await env.R2.delete(key);
}

export async function putScrapeInputTemp(env: Env, bytes: Uint8Array, contentType: string): Promise<{ kind: 'r2'; key: string }> {
	const key = `${SCRAPE_INPUT_TEMP_PREFIX}${crypto.randomUUID()}.${extensionFromMime(contentType)}`;
	await putTempBytes(env, key, bytes, contentType);
	return { kind: 'r2', key };
}

export async function deleteScrapeInputTemp(env: Env, key: string): Promise<void> {
	await deleteTempObject(env, key, { prefix: SCRAPE_INPUT_TEMP_PREFIX, label: 'scrape input temp object' });
}

export function isScrapeInputTempKey(key: string): boolean {
	return key.startsWith(SCRAPE_INPUT_TEMP_PREFIX);
}
