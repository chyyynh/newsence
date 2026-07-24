export type ResourceRelationsReadPath = 'legacy' | 'v2';

export function resolveResourceRelationsReadPath(value: unknown): ResourceRelationsReadPath {
	return value === 'v2' ? 'v2' : 'legacy';
}

export function usesV2ResourceRelations(env: { RESOURCE_RELATIONS_READ_PATH?: unknown }): boolean {
	return resolveResourceRelationsReadPath(env.RESOURCE_RELATIONS_READ_PATH) === 'v2';
}
