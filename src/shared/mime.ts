export const PDF_MIME = 'application/pdf';

/**
 * Content-based media type sniffing (#162 hardening).
 *
 * Ingest paths trust client-declared MIME (multipart upload) and upstream
 * Content-Type (URL ingest) only as a cheap first filter — both are
 * attacker-controlled, so a payload can claim `image/png` while carrying HTML,
 * an SVG with inline script, or arbitrary bytes. We verify the real file
 * signature before committing to R2 so a non-image can never be stored under
 * the image/PDF surface and later served.
 *
 * SVG / HTML / scripts have no binary magic and therefore sniff to `null`,
 * which the callers reject.
 */
export const MAGIC_SNIFF_BYTES = 12;

export type SniffedMediaType =
	| 'image/png'
	| 'image/jpeg'
	| 'image/gif'
	| 'image/webp'
	| 'image/avif'
	| 'image/heic'
	| 'image/bmp'
	| 'image/tiff'
	| typeof PDF_MIME;

export class UnsupportedMediaError extends Error {
	constructor() {
		super('Content does not match a supported image or PDF format');
		this.name = 'UnsupportedMediaError';
	}
}

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

function matchesAt(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
	if (buf.length < offset + sig.length) return false;
	for (let i = 0; i < sig.length; i++) {
		if (buf[offset + i] !== sig[i]) return false;
	}
	return true;
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'mif1', 'msf1']);

/** Identify a media type from its leading bytes, or `null` when unsupported. */
export function sniffMediaType(header: Uint8Array): SniffedMediaType | null {
	if (matchesAt(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	if (matchesAt(header, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (matchesAt(header, ascii('GIF87a')) || matchesAt(header, ascii('GIF89a'))) return 'image/gif';
	if (matchesAt(header, ascii('%PDF-'))) return PDF_MIME;
	if (matchesAt(header, ascii('RIFF')) && matchesAt(header, ascii('WEBP'), 8)) return 'image/webp';
	if (matchesAt(header, ascii('BM'))) return 'image/bmp';
	if (matchesAt(header, [0x49, 0x49, 0x2a, 0x00]) || matchesAt(header, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
	if (matchesAt(header, ascii('ftyp'), 4) && header.length >= 12) {
		const brand = String.fromCharCode(header[8], header[9], header[10], header[11]);
		if (brand === 'avif' || brand === 'avis') return 'image/avif';
		if (HEIC_BRANDS.has(brand)) return 'image/heic';
	}
	return null;
}

/**
 * Stream wrapper that sniffs the leading bytes before letting any data through.
 * If the signature doesn't pass `accept`, the stream errors with
 * `UnsupportedMediaError`; R2 will not commit a partial object from an errored
 * source stream.
 */
export function sniffMediaTypeStream(
	body: ReadableStream<Uint8Array>,
	accept: (type: SniffedMediaType) => boolean,
): { stream: ReadableStream<Uint8Array>; getDetected: () => SniffedMediaType | null } {
	let detected: SniffedMediaType | null = null;
	let decided = false;
	let header = new Uint8Array(0);

	const decideAndFlush = (controller: TransformStreamDefaultController<Uint8Array>): boolean => {
		const type = sniffMediaType(header);
		if (!type || !accept(type)) {
			controller.error(new UnsupportedMediaError());
			return false;
		}
		detected = type;
		decided = true;
		controller.enqueue(header);
		return true;
	};

	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (decided) {
					controller.enqueue(chunk);
					return;
				}
				const merged = new Uint8Array(header.length + chunk.byteLength);
				merged.set(header, 0);
				merged.set(chunk, header.length);
				header = merged;
				if (header.length < MAGIC_SNIFF_BYTES) return;
				decideAndFlush(controller);
			},
			flush(controller) {
				if (decided) return;
				if (header.length === 0) {
					controller.error(new UnsupportedMediaError());
					return;
				}
				decideAndFlush(controller);
			},
		}),
	);

	return { stream, getDetected: () => detected };
}
