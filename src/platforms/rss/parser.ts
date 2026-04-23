// ─────────────────────────────────────────────────────────────
// RSS Parsing Utilities
// ─────────────────────────────────────────────────────────────

export type RSSItem = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getPath(value: unknown, path: string[]): unknown {
	let current: unknown = value;
	for (const key of path) {
		const record = asRecord(current);
		if (!record) return undefined;
		current = record[key];
	}
	return current;
}

function normalizeItems(value: unknown): RSSItem[] {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	return values.filter((item): item is RSSItem => asRecord(item) !== undefined);
}

export function toPlainText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		return value.map(toPlainText).filter(Boolean).join(' ');
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const preferredKeys = ['#text', '_text', 'text', 'value', 'content', 'summary', 'description'];
		for (const key of preferredKeys) {
			const text = toPlainText(record[key]);
			if (text) return text;
		}
		return Object.values(record).map(toPlainText).filter(Boolean).join(' ');
	}
	return '';
}

export function stripHtml(raw: unknown): string {
	const text = toPlainText(raw);
	if (!text) return '';
	return text
		.replace(/<[^>]*>/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ')
		.trim();
}

export function htmlToMarkdown(html: string): string {
	return (
		html
			// Block elements
			.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
			.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
			.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
			.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n')
			.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n\n##### $1\n\n')
			.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n\n###### $1\n\n')
			// Lists
			.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
			.replace(/<\/?[ou]l[^>]*>/gi, '\n')
			// Inline elements
			.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
			.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
			.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
			.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*')
			.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
			.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/gi, '^($1)')
			// Block breaks
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n\n')
			.replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
			.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) =>
				content
					.trim()
					.split('\n')
					.map((line: string) => `> ${line}`)
					.join('\n'),
			)
			// Strip remaining tags
			.replace(/<[^>]*>/g, '')
			// HTML entities
			.replace(/&quot;/g, '"')
			.replace(/&#x27;|&#39;/g, "'")
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&nbsp;/g, ' ')
			// Clean up whitespace
			.replace(/\n{3,}/g, '\n\n')
			.trim()
	);
}

export function extractRssFullContent(item: RSSItem): string {
	const raw = toPlainText(item['content:encoded']) || toPlainText(item.content) || toPlainText(item.description);
	if (!raw || raw.length < 800) return '';
	return htmlToMarkdown(raw);
}

export function extractUrlFromItem(item: RSSItem): string | null {
	if (typeof item.link === 'string') return item.link;
	const link = asRecord(item.link);
	return asString(link?.['@_href']) ?? asString(link?.href) ?? asString(item.url) ?? null;
}

function extractEnclosureImage(item: RSSItem): string | null {
	const enclosure = asRecord(item.enclosure);
	if (!enclosure) return null;
	const url = asString(enclosure['@_url']) ?? asString(enclosure.url);
	const type = asString(enclosure['@_type']) ?? asString(enclosure.type) ?? '';
	return url && (!type || type.startsWith('image/')) ? url : null;
}

function extractImageFromMediaEntry(entryValue: unknown): string | null {
	const entry = asRecord(entryValue);
	if (!entry) return null;
	const url = asString(entry['@_url']) ?? asString(entry.url);
	if (url) return url;
	const nested = entry['media:content'] ?? entry['media:thumbnail'];
	for (const nestedValue of normalizeItems(nested)) {
		const nestedUrl = asString(nestedValue['@_url']) ?? asString(nestedValue.url);
		if (nestedUrl) return nestedUrl;
	}
	return null;
}

function extractMediaImage(item: RSSItem): string | null {
	for (const key of ['media:content', 'media:thumbnail', 'media:group']) {
		for (const entry of normalizeItems(item[key])) {
			const url = extractImageFromMediaEntry(entry);
			if (url) return url;
		}
	}
	return null;
}

function extractItunesImage(item: RSSItem): string | null {
	if (typeof item['itunes:image'] === 'string') return item['itunes:image'];
	const itunes = asRecord(item['itunes:image']);
	if (!itunes) return null;
	return asString(itunes['@_href']) ?? asString(itunes.href) ?? null;
}

function extractEmbeddedImage(item: RSSItem): string | null {
	const html = toPlainText(item.description) || toPlainText(item['content:encoded']);
	if (!html) return null;
	return html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null;
}

/**
 * Extract an image URL from RSS item metadata.
 * Checks enclosure, media:content, media:thumbnail, itunes:image, and
 * first <img> in description/content.
 */
export function extractImageFromItem(item: RSSItem): string | null {
	return extractEnclosureImage(item) ?? extractMediaImage(item) ?? extractItunesImage(item) ?? extractEmbeddedImage(item);
}

export function extractItemsFromFeed(data: unknown): RSSItem[] {
	const source =
		getPath(data, ['rss', 'channel', 'item']) ??
		getPath(data, ['feed', 'entry']) ??
		getPath(data, ['channel', 'item']) ??
		getPath(data, ['rdf:RDF', 'item']);
	return normalizeItems(source);
}
