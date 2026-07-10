const MARKDOWN_INLINE_DATA_IMAGE = /!\[[^\]\r\n]*\]\(\s*data:image\/[^)]*\)/gi;
const HTML_INLINE_DATA_IMAGE = /<img\b[^>]*\bsrc\s*=\s*(["'])data:image\/[\s\S]*?\1[^>]*>/gi;

export function sanitizeExtractedMarkdown(content: string): string {
	const trimmed = content.trim();
	if (!trimmed.toLowerCase().includes('data:image/')) return trimmed;
	return trimmed
		.replace(MARKDOWN_INLINE_DATA_IMAGE, '')
		.replace(HTML_INLINE_DATA_IMAGE, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
