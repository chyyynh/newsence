import { Env } from '../types';

export function handleStatus(_env: Env): Response {
	return new Response(JSON.stringify({
		worker: 'newsence-core-test',
		version: '1.0.0',
		features: ['rss-monitor', 'twitter-monitor', 'article-process', 'workflow'],
		timestamp: new Date().toISOString()
	}), {
		headers: { 'Content-Type': 'application/json' }
	});
}
