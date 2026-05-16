export function isRasterImage(contentType: string): boolean {
	const lower = contentType.toLowerCase();
	return lower.startsWith('image/') && !lower.startsWith('image/svg');
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
