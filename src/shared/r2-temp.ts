import { extensionFromMime } from './mime';
import type { Env } from './types';

type TempObjectGuard = {
	prefix?: string;
	label: string;
};

const SCRAPE_INPUT_TEMP_PREFIX = 'tmp/scrape/';
const JSON_TEMP_CONTENT_TYPE = 'application/json; charset=utf-8';

function assertTempObjectKey(key: string, guard: TempObjectGuard): void {
	if (guard.prefix && !key.startsWith(guard.prefix)) {
		throw new Error(`Invalid ${guard.label} key: ${key}`);
	}
}

function randomTempObjectKey(prefix: string, extension: string): string {
	return `${prefix}${crypto.randomUUID()}.${extension}`;
}

export async function putTempText(env: Env, key: string, text: string, contentType: string): Promise<void> {
	await env.R2.put(key, text, {
		httpMetadata: { contentType },
	});
}

async function putSerializedTempJson(env: Env, key: string, json: string): Promise<void> {
	await putTempText(env, key, json, JSON_TEMP_CONTENT_TYPE);
}

export async function putRandomSerializedTempJson(env: Env, prefix: string, json: string): Promise<string> {
	const key = randomTempObjectKey(prefix, 'json');
	await putSerializedTempJson(env, key, json);
	return key;
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

export async function readTempJson<T>(env: Env, key: string, guard: TempObjectGuard): Promise<T> {
	return JSON.parse(await readTempText(env, key, guard)) as T;
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
	const key = randomTempObjectKey(SCRAPE_INPUT_TEMP_PREFIX, extensionFromMime(contentType));
	await putTempBytes(env, key, bytes, contentType);
	return { kind: 'r2', key };
}

export async function deleteScrapeInputTemp(env: Env, key: string): Promise<void> {
	await deleteTempObject(env, key, { prefix: SCRAPE_INPUT_TEMP_PREFIX, label: 'scrape input temp object' });
}

export function isScrapeInputTempKey(key: string): boolean {
	return key.startsWith(SCRAPE_INPUT_TEMP_PREFIX);
}
