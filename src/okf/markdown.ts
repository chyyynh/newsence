export function markdownLink(label: string, target: string): string {
	return `[${escapeMarkdownLinkText(oneLine(label))}](${escapeMarkdownLinkTarget(target)})`;
}

function escapeMarkdownLinkText(value: string): string {
	return value.replace(/([\\[\]])/g, '\\$1');
}

function escapeMarkdownLinkTarget(value: string): string {
	return value.startsWith('/') ? value : `<${value.replace(/[\s<>]/g, (character) => encodeURIComponent(character))}>`;
}

export function frontmatter(fields: Record<string, unknown>): string {
	const lines = ['---'];
	for (const [key, value] of Object.entries(fields)) {
		const yaml = yamlValue(value);
		if (yaml !== null) lines.push(`${key}: ${yaml}`);
	}
	lines.push('---');
	return lines.join('\n');
}

function yamlValue(value: unknown): string | null {
	if (value === null || value === undefined || value === '') return null;
	if (Array.isArray(value)) {
		const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
		return items.length ? `[${items.map((item) => JSON.stringify(item)).join(', ')}]` : null;
	}
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

export function compactMarkdown(parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join('\n\n')
		.concat('\n');
}

export function oneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

export function assignPaths(items: Array<{ id: string; label: string }>, prefix: string): Map<string, string> {
	const used = new Set<string>();
	const paths = new Map<string, string>();
	for (const item of items) {
		const base = slugify(item.label) || slugify(item.id) || 'item';
		let slug = base;
		for (let index = 2; used.has(slug); index++) slug = `${base}-${index}`;
		used.add(slug);
		paths.set(item.id, `${prefix}/${slug}.md`);
	}
	return paths;
}

export function uniqueSlug(label: string, id: string): string {
	return `${slugify(label) || 'collection'}-${slugify(id) || 'item'}`;
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 72);
}

export function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
	const map = new Map<K, T[]>();
	for (const item of items) {
		const itemKey = key(item);
		const values = map.get(itemKey) ?? [];
		values.push(item);
		map.set(itemKey, values);
	}
	return map;
}

export function uniqueBy<T, K>(items: T[], key: (item: T) => K): T[] {
	const seen = new Set<K>();
	return items.filter((item) => {
		const itemKey = key(item);
		if (seen.has(itemKey)) return false;
		seen.add(itemKey);
		return true;
	});
}
