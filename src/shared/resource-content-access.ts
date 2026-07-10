export const RESOURCE_CONTENT_SURFACES = ['app', 'ai-tools', 'export'] as const;

export type ResourceContentSurface = (typeof RESOURCE_CONTENT_SURFACES)[number];

// Signed-in app readers can inspect corpus bodies; AI and exports stay
// library-gated so stored or paywalled content is not redistributed by default.
const ALLOWS_SIGNED_IN_CORPUS_CONTENT: Record<ResourceContentSurface, boolean> = {
	app: true,
	'ai-tools': false,
	export: false,
};

export function resourceContentSurfaceAllowsCorpus(surface: ResourceContentSurface): boolean {
	return ALLOWS_SIGNED_IN_CORPUS_CONTENT[surface];
}

export function hasResourceContentAccess(input: {
	surface: ResourceContentSurface;
	hasViewer: boolean;
	scope: string;
	inViewerLibrary: boolean;
}): boolean {
	if (!input.hasViewer) return false;
	return input.inViewerLibrary || (input.scope === 'corpus' && resourceContentSurfaceAllowsCorpus(input.surface));
}
