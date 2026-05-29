import type { Env } from '@shared/types';

export function handleHealth(_env: Env): Response {
	return Response.json({
		status: 'ok',
		worker: 'newsence-core',
		timestamp: new Date().toISOString(),
	});
}
