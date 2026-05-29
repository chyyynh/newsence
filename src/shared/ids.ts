const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string): boolean {
	return UUID_REGEX.test(id);
}

export function documentPath({ docId, workspaceId }: { docId: string; workspaceId: string }): string {
	return `/w/${workspaceId}?d=${encodeURIComponent(docId)}`;
}

export function toMap<T, K extends string | number>(items: T[], keyFn: (item: T) => K): Map<K, T> {
	return new Map(items.map((item) => [keyFn(item), item]));
}
