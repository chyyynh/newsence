export const WEB_FETCH_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

const DEFAULT_TEXT_MAX_BYTES = 1024 * 1024;

export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
	try {
		const timeout = AbortSignal.timeout(timeoutMs);
		return await fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
	} catch (err) {
		if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
			throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
		}
		throw err;
	}
}

export async function readTextWithLimit(response: Response, maxBytes = DEFAULT_TEXT_MAX_BYTES): Promise<string> {
	const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
	if (contentLength > maxBytes) {
		await response.body?.cancel();
		throw new Error(`Response too large: ${contentLength} bytes`);
	}
	if (!response.body) return '';

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let totalBytes = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();

		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Response body exceeded ${maxBytes} bytes`);
		}
		text += decoder.decode(value, { stream: true });
	}
}

export async function readBytesWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
	const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
	if (contentLength > maxBytes) {
		await response.body?.cancel();
		throw new Error(`Response too large: ${contentLength} bytes`);
	}
	if (!response.body) return new Uint8Array();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			const bytes = new Uint8Array(totalBytes);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return bytes;
		}

		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Response body exceeded ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
}
