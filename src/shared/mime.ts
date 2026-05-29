export function isRasterImage(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return lower.startsWith('image/') && !lower.startsWith('image/svg');
}

const BASE64_DATA_URL_RE = /^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+);base64,(.+)$/;

/** Worker-runtime base64 data URL parser. Frontend has its own Buffer-returning version. */
export function parseBase64DataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string } | null {
	const m = dataUrl.match(BASE64_DATA_URL_RE);
	if (!m) return null;
	const bin = atob(m[2]);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return { bytes, contentType: m[1] };
}

/**
 * Prefer the filename's extension when it looks safe (lowercase alnum, ≤8 chars);
 * otherwise derive from the MIME subtype. `jpeg` is normalized to `jpg`.
 */
export function extensionFromMime(contentType: string, fileName?: string): string {
	if (fileName) {
		const fromName = fileName.split('.').pop()?.toLowerCase();
		if (fromName && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
	}
	const subtype = contentType.split('/')[1]?.split(';')[0]?.split('+')[0]?.trim() ?? 'bin';
	return subtype === 'jpeg' ? 'jpg' : subtype;
}
