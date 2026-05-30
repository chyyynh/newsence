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

// Bytes needed to discriminate every signature below. The ISO-BMFF brand
// (AVIF/HEIC) lives at offset 8..12, so 12 bytes is the worst case.
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
	| 'application/pdf';

export class UnsupportedMediaError extends Error {
	constructor() {
		super('Content does not match a supported image or PDF format');
		this.name = 'UnsupportedMediaError';
	}
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

/**
 * Identify a media type from its leading bytes, or `null` when the signature
 * matches no supported format.
 */
export function sniffMediaType(header: Uint8Array): SniffedMediaType | null {
	if (matchesAt(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	if (matchesAt(header, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (matchesAt(header, ascii('GIF87a')) || matchesAt(header, ascii('GIF89a'))) return 'image/gif';
	if (matchesAt(header, ascii('%PDF-'))) return 'application/pdf';
	// RIFF container with a WEBP fourCC at offset 8.
	if (matchesAt(header, ascii('RIFF')) && matchesAt(header, ascii('WEBP'), 8)) return 'image/webp';
	// BMP / TIFF (little- and big-endian) — kept for parity with the raster set
	// the ingest paths previously accepted by declared MIME alone.
	if (matchesAt(header, ascii('BM'))) return 'image/bmp';
	if (matchesAt(header, [0x49, 0x49, 0x2a, 0x00]) || matchesAt(header, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
	// ISO-BMFF `ftyp` box at offset 4 → AVIF / HEIC family by brand.
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
 * `UnsupportedMediaError` — and since R2 never commits a partial object when its
 * source stream errors, nothing is stored. Mirrors `streamWithByteLimit`'s
 * fail-before-commit guarantee for unbounded upstream bodies.
 */
export function sniffMediaTypeStream(
	body: ReadableStream<Uint8Array>,
	accept: (type: SniffedMediaType) => boolean,
): { stream: ReadableStream<Uint8Array>; getDetected: () => SniffedMediaType | null } {
	let detected: SniffedMediaType | null = null;
	let decided = false;
	let header = new Uint8Array(0);

	// Validate `header`, flushing it downstream on success. Returns false (after
	// erroring the stream) when the content is unsupported.
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
				if (header.length < MAGIC_SNIFF_BYTES) return; // accumulate until discriminable
				decideAndFlush(controller);
			},
			flush(controller) {
				// Stream ended before MAGIC_SNIFF_BYTES — decide on what we have (a
				// tiny JPEG needs only 3 bytes), else reject.
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
