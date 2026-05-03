/**
 * HMAC-SHA256 sign / verify for /proxy/ URLs.
 *
 * Sign input: `encodedUrl + ":" + exp`. The `{options}` segment (w/q) is
 * intentionally NOT signed so Next.js can request multiple widths from one
 * stored URL without per-render re-signing. The proxy handler must keep a
 * strict allowlist for supported widths/qualities because these options are
 * public input.
 */

export const PROXY_PATH_PASSTHROUGH = 'passthrough';

const ENCODER = new TextEncoder();

let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function importKey(secret: string): Promise<CryptoKey> {
	if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
	const key = await crypto.subtle.importKey('raw', ENCODER.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
	cachedKey = { secret, key };
	return key;
}

function bytesToHex(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let out = '';
	for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, '0');
	return out;
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length === 0 || hex.length % 2 !== 0) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		if (Number.isNaN(byte)) return null;
		out[i] = byte;
	}
	return out;
}

interface ProxySigningEnv {
	IMAGE_PROXY_SECRET?: string;
	CORE_WORKER_PUBLIC_URL?: string;
}

export interface ProxySigningConfig {
	secret: string;
	origin: string;
}

/** Returns null when the worker isn't configured to sign — caller decides between no-op and 503. */
export function getProxySigningConfig(env: ProxySigningEnv): ProxySigningConfig | null {
	if (!env.IMAGE_PROXY_SECRET || !env.CORE_WORKER_PUBLIC_URL) return null;
	return { secret: env.IMAGE_PROXY_SECRET, origin: env.CORE_WORKER_PUBLIC_URL.replace(/\/$/, '') };
}

/** Default 1-year exp: long enough that articles don't go dark, short enough that leaked URLs eventually stop working. */
export async function signProxyUrl(origin: string, upstreamUrl: string, secret: string, ttlSec = 60 * 60 * 24 * 365): Promise<string> {
	const encodedUrl = encodeURIComponent(upstreamUrl);
	const exp = Math.floor(Date.now() / 1000) + ttlSec;
	const key = await importKey(secret);
	const sig = await crypto.subtle.sign('HMAC', key, ENCODER.encode(`${encodedUrl}:${exp}`));
	return `${origin}/proxy/${PROXY_PATH_PASSTHROUGH}/${encodedUrl}?sig=${bytesToHex(sig)}&exp=${exp}`;
}

export async function verifyProxySignature(encodedUrl: string, sig: string, exp: string, secret: string): Promise<boolean> {
	const expNum = Number.parseInt(exp, 10);
	if (!Number.isFinite(expNum) || expNum <= Math.floor(Date.now() / 1000)) return false;
	const sigBytes = hexToBytes(sig);
	if (!sigBytes) return false;
	const key = await importKey(secret);
	return crypto.subtle.verify('HMAC', key, sigBytes, ENCODER.encode(`${encodedUrl}:${expNum}`));
}

/** No-op fallback in dev (no secret) and idempotent over already-signed / non-http inputs. */
export async function signOgImageForStorage(env: ProxySigningEnv, rawUrl: string | null | undefined): Promise<string | null> {
	if (!rawUrl) return null;
	const config = getProxySigningConfig(env);
	if (!config) return rawUrl;
	if (!/^https?:\/\//i.test(rawUrl)) return rawUrl;
	if (rawUrl.startsWith(`${config.origin}/proxy/`)) return rawUrl;
	return signProxyUrl(config.origin, rawUrl, config.secret);
}
