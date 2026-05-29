/**
 * Wrap a byte stream so that piping it errors as soon as the running total
 * exceeds `maxBytes`. Used in front of `env.R2.put` to enforce upload caps on
 * unknown-length upstream bodies without buffering the whole payload in
 * memory (R2 will not commit a partial object when the stream errors).
 *
 * Returns the wrapped stream plus a `getBytesSeen()` getter so callers can
 * record the final size after the consumer (R2) drains the stream.
 *
 * Why not `FixedLengthStream`? That primitive enforces an *exact* length and
 * rejects shorter/longer streams — fine when `Content-Length` is trustworthy,
 * but we routinely accept bodies whose declared length is missing or wrong.
 */
export class PayloadTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`Response body exceeded ${maxBytes} bytes`);
		this.name = 'PayloadTooLargeError';
	}
}

export function streamWithByteLimit(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): { stream: ReadableStream<Uint8Array>; getBytesSeen: () => number } {
	let bytesSeen = 0;
	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytesSeen += chunk.byteLength;
				if (bytesSeen > maxBytes) {
					controller.error(new PayloadTooLargeError(maxBytes));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return { stream, getBytesSeen: () => bytesSeen };
}
