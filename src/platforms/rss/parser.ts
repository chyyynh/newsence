// ─────────────────────────────────────────────────────────────
// RSS Parsing Utilities
// ─────────────────────────────────────────────────────────────

export type RSSItem = Record<string, any>;

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
	return item.link?.['@_href'] ?? item.link?.href ?? item.url ?? null;
}

/**
 * Extract an image URL from RSS item metadata.
 * Checks enclosure, media:content, media:thumbnail, itunes:image, and
 * first <img> in description/content.
 */
export function extractImageFromItem(item: RSSItem): string | null {
	// enclosure (podcasts, some blogs)
	const enclosure = item.enclosure;
	if (enclosure) {
		const url = enclosure['@_url'] ?? enclosure.url;
		const type = enclosure['@_type'] ?? enclosure.type ?? '';
		if (typeof url === 'string' && (!type || type.startsWith('image/'))) return url;
	}

	// media:content / media:thumbnail (Media RSS)
	for (const key of ['media:content', 'media:thumbnail', 'media:group']) {
		const media = item[key];
		if (!media) continue;
		const entries = Array.isArray(media) ? media : [media];
		for (const entry of entries) {
			const url = entry?.['@_url'] ?? entry?.url;
			if (typeof url === 'string') return url;
			// media:group wraps media:content
			const nested = entry?.['media:content'] ?? entry?.['media:thumbnail'];
			const nestedUrl = nested?.['@_url'] ?? nested?.url;
			if (typeof nestedUrl === 'string') return nestedUrl;
		}
	}

	// itunes:image
	const itunes = item['itunes:image'];
	if (itunes) {
		const url = itunes['@_href'] ?? itunes.href ?? (typeof itunes === 'string' ? itunes : null);
		if (typeof url === 'string') return url;
	}

	// First <img src> in description or content
	const html = toPlainText(item.description) || toPlainText(item['content:encoded']);
	if (html) {
		const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
		if (match?.[1]) return match[1];
	}

	return null;
}

export function extractItemsFromFeed(data: any): RSSItem[] {
	const source = data?.rss?.channel?.item ?? data?.feed?.entry ?? data?.channel?.item ?? data?.['rdf:RDF']?.item;
	return source ? (Array.isArray(source) ? source : [source]) : [];
}
