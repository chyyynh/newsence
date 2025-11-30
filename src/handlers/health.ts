import { Env } from '../types';

export function handleHealth(_env: Env): Response {
	return new Response(JSON.stringify({
		status: 'ok',
		worker: 'newsence-core-test',
		timestamp: new Date().toISOString()
	}), {
		headers: { 'Content-Type': 'application/json' }
	});
}
