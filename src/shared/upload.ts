import { PDF_MIME } from './mime';
import { buildMetadata } from './platform-metadata';

// Single source of truth for the blob-ingest size cap. Every path that accepts a
// user file — multipart upload, URL→blob, external image URL, and the /scrape
// raw-bytes body — rejects above this. Keep them in lockstep by importing here
// rather than redeclaring the literal.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Filename → display title: drop the file extension (`report.pdf` → `report`,
// `vacation.jpg` → `vacation`). Shared by every blob-ingest path so the same
// file yields the same title however it arrived. Falls back to the raw name for
// degenerate inputs like `.pdf`.
export function deriveFileTitle(fileName: string): string {
	return fileName.replace(/\.[a-z0-9]{1,8}$/i, '') || fileName;
}

// Builds the `user_files.metadata` jsonb for a stored PDF, or null for any other
// type. Folding the PDF check in here keeps the "is this a PDF?" branch out of
// every caller. Shared by the multipart-upload and URL→blob paths. The fetch URL
// is intentionally NOT stored — it's derived from `storage_key` at read time
// (see frontend `getUserFileResourceUrl`), so a route rename can't rot the row.
export function buildPdfMetadata(args: { fileType: string; fileName: string; fileSize: number }) {
	if (args.fileType !== PDF_MIME) return null;
	return buildMetadata('pdf', {
		fileName: args.fileName,
		fileSize: args.fileSize,
	});
}
