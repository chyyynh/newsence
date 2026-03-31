import { scrapeWebPage } from '../../domain/scrapers';
import type { Env } from '../../models/types';
import { isSubmitAuthorized } from '../middleware/auth';

export function handleHealth(_env: Env): Response {
	return Response.json({
		status: 'ok',
		worker: 'newsence-core',
		timestamp: new Date().toISOString(),
	});
}

export async function handleTestScrape(request: Request, env: Env): Promise<Response> {
	if (!(await isSubmitAuthorized(request, env))) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	const reqUrl = new URL(request.url);
	const url = reqUrl.searchParams.get('url');
	if (!url) return Response.json({ error: 'Missing ?url= parameter' }, { status: 400 });

	const start = Date.now();
	try {
		const r = await scrapeWebPage(url);
		return Response.json({
			url,
			results: { crawl: { chars: r.content.length, title: r.title, content: r.content, ms: Date.now() - start } },
		});
	} catch (e) {
		return Response.json({ url, results: { crawl: { error: String(e) } } });
	}
}
