const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
	amp: '&',
	apos: "'",
	gt: '>',
	lt: '<',
	nbsp: ' ',
	quot: '"',
};

function decodeCodePoint(entity: string, rawCodePoint: string, radix: 10 | 16): string {
	const codePoint = Number.parseInt(rawCodePoint, radix);
	if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
		return entity;
	}
	return String.fromCodePoint(codePoint);
}

export function decodeHtmlEntities(value: string): string {
	return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|apos|gt|lt|nbsp|quot));/gi, (entity, decimal, hex, named) => {
		if (decimal) return decodeCodePoint(entity, decimal, 10);
		if (hex) return decodeCodePoint(entity, hex, 16);
		return NAMED_HTML_ENTITIES[String(named).toLowerCase()] ?? entity;
	});
}
