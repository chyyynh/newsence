// ─────────────────────────────────────────────────────────────
// HTML text helpers — single source of truth for tag stripping
// and entity decoding across ingest scrapers/parsers.
// ─────────────────────────────────────────────────────────────

/**
 * Decode the common named/numeric HTML entities to their literal characters.
 * `&amp;` is decoded LAST so that double-encoded sequences like `&amp;lt;`
 * resolve to `&lt;` rather than collapsing all the way to `<`.
 */
export function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&#x2F;/g, '/')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

/** Replace every HTML/XML tag with a single space. */
export function stripHtmlTags(str: string): string {
	return str.replace(/<[^>]*>/g, ' ');
}

/** Strip tags, decode entities, and collapse runs of whitespace into single spaces. */
export function htmlToText(str: string): string {
	return decodeHtmlEntities(stripHtmlTags(str)).replace(/\s+/g, ' ').trim();
}
