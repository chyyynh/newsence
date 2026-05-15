import { BROWSER_UA } from '../../infra/fetch';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BLOB_BYTES = 10 * 1024 * 1024;

export interface FetchedBlob {
	bytes: ArrayBuffer;
	contentType: string;
	finalUrl: string;
	/** Filename derived from Content-Disposition or URL pathname. */
	suggestedFilename: string;
}

function parseContentDisposition(header: string | null): string | null {
	if (!header) return null;
	const match = header.match(/filename\*=UTF-8''([^;]+)|filename=("([^"]+)"|([^;]+))/i);
	const raw = match?.[1] ?? match?.[3] ?? match?.[4];
	if (!raw) return null;
	try {
		return decodeURIComponent(raw.trim());
	} catch {
		return raw.trim();
	}
}

function filenameFromUrl(url: string, fallback: string): string {
	try {
		const pathname = new URL(url).pathname;
		const tail = pathname.split('/').filter(Boolean).pop();
		return tail || fallback;
	} catch {
		return fallback;
	}
}

/**
 * Fetch a non-HTML resource (PDF / image / etc.) into memory with a hard
 * size cap. Used by the URL-ingest blob path — bytes get streamed onward to
 * R2 in the caller, then dropped. Caller is responsible for content-type
 * allowlisting (this function trusts the contentType arg).
 */
export async function fetchBlob(url: string, expectedContentType: string, fallbackFilename: string): Promise<FetchedBlob> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			signal: ctrl.signal,
			headers: { 'User-Agent': BROWSER_UA, Accept: expectedContentType },
		});
		if (!res.ok) throw new Error(`Upstream returned ${res.status}`);

		const declaredLength = Number.parseInt(res.headers.get('content-length') ?? '', 10);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_BLOB_BYTES) {
			throw new Error(`Resource exceeds ${MAX_BLOB_BYTES} bytes (declared ${declaredLength})`);
		}

		// Stream with a hard byte cap to guard against missing/lying Content-Length.
		const chunks: Uint8Array[] = [];
		let total = 0;
		const reader = res.body?.getReader();
		if (!reader) throw new Error('Empty response body');
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BLOB_BYTES) {
				reader.cancel();
				throw new Error(`Response body exceeded ${MAX_BLOB_BYTES} bytes`);
			}
			chunks.push(value);
		}

		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}

		const finalUrl = res.url || url;
		const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? expectedContentType;
		const cdName = parseContentDisposition(res.headers.get('content-disposition'));
		const suggestedFilename = cdName ?? filenameFromUrl(finalUrl, fallbackFilename);

		return { bytes: bytes.buffer, contentType, finalUrl, suggestedFilename };
	} finally {
		clearTimeout(timer);
	}
}
