/**
 * HMAC-SHA256 verify for /proxy/ URLs.
 *
 * Signing happens in the frontend at the API boundary (see
 * frontend/src/lib/r2/sign-proxy-url.ts). The worker only verifies. Sign
 * input is `encodedUrl + ":" + exp`; the `{options}` segment (w/q) is
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

async function verifyHmacSig(buildSignInput: (expNum: number) => string, sig: string, exp: string, secret: string): Promise<boolean> {
	const expNum = Number.parseInt(exp, 10);
	if (!Number.isFinite(expNum) || expNum <= Math.floor(Date.now() / 1000)) return false;
	const sigBytes = hexToBytes(sig);
	if (!sigBytes) return false;
	const key = await importKey(secret);
	return crypto.subtle.verify('HMAC', key, sigBytes, ENCODER.encode(buildSignInput(expNum)));
}

export function verifyProxySignature(encodedUrl: string, sig: string, exp: string, secret: string): Promise<boolean> {
	return verifyHmacSig((n) => `${encodedUrl}:${n}`, sig, exp, secret);
}

/**
 * Sign input is `r2:${storageKey}:${exp}` — distinct prefix from /proxy/
 * prevents a leaked /proxy/ sig from being replayed here.
 */
export function verifyR2KeySignature(storageKey: string, sig: string, exp: string, secret: string): Promise<boolean> {
	return verifyHmacSig((n) => `r2:${storageKey}:${n}`, sig, exp, secret);
}
