import { type ResourceContentSurface, resourceContentSurfaceAllowsCorpus } from '@core-shared/resource-content-access';
import { type SQL, sql } from 'drizzle-orm';

export function resourceContentAccessSql(
	surface: ResourceContentSurface,
	input: { hasViewer: SQL; inViewerLibrary: SQL; scope: SQL },
): SQL {
	return resourceContentSurfaceAllowsCorpus(surface)
		? sql`(${input.hasViewer} AND (${input.inViewerLibrary} OR ${input.scope} = 'corpus'))`
		: sql`(${input.hasViewer} AND ${input.inViewerLibrary})`;
}
