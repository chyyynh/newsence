import { logError } from '../../infra/log';
import { callOpenRouter, extractJson } from '../../infra/openrouter';
import { normalizeUrl } from '../../infra/web';
import { detectPlatformType } from '../../models/scraped-content';
import type { Env } from '../../models/types';
import { scrapeUrl } from '../../platforms/registry';
import { parseJsonBody, requireAuth } from '../middleware/auth';

/** Extract the first URL from a string (handles messages like "@bot https://example.com check this") */
function extractUrl(text: string): string | null {
	const match = text.match(/https?:\/\/[^\s<>"']+/i);
	return match ? match[0] : null;
}

const PREVIEW_DEFAULT_MODEL = 'google/gemini-3.1-flash-lite-preview';

const PREVIEW_PROMPT_TEMPLATE = `You are a news editor assistant. Given the following article, produce a JSON object with:
- "title_cn": a concise Traditional Chinese title (繁體中文)
- "summary_cn": a 2-3 sentence Traditional Chinese summary (繁體中文)

Article title: {title}
Article content (truncated):
{content}

Respond with ONLY the JSON object, no markdown fences.`;

async function quickTranslate(
	title: string,
	content: string,
	apiKey: string,
	model: string,
): Promise<{ titleCn: string; summaryCn: string }> {
	const prompt = PREVIEW_PROMPT_TEMPLATE.replace('{title}', title).replace('{content}', content.slice(0, 4000));
	const raw = await callOpenRouter(prompt, {
		apiKey,
		model,
		maxTokens: 500,
		temperature: 0.2,
		timeoutMs: 15_000,
	});
	if (raw) {
		const parsed = extractJson<{ title_cn?: string; summary_cn?: string }>(raw);
		if (parsed) return { titleCn: parsed.title_cn || '', summaryCn: parsed.summary_cn || '' };
	}
	return { titleCn: '', summaryCn: '' };
}

type PreviewBody = {
	url?: string;
	message?: string;
	model?: string;
};

/**
 * Preview-only endpoint: scrape + quick AI translate, no DB writes.
 * Persistence is the frontend's responsibility (POST /api/upload → /submit).
 */
export async function handlePreview(request: Request, env: Env): Promise<Response> {
	const unauth = await requireAuth(request, env);
	if (unauth) return unauth;

	let url: string | null = null;
	let model = PREVIEW_DEFAULT_MODEL;

	if (request.method === 'GET') {
		const params = new URL(request.url).searchParams;
		url = params.get('url');
		model = params.get('model') || model;
	} else {
		const body = await parseJsonBody<PreviewBody>(request);
		if (body instanceof Response) return body;
		url = body.url ?? (body.message ? extractUrl(body.message) : null);
		model = body.model || model;
	}

	if (!url) {
		return Response.json({ error: 'Missing url (or no URL found in message)' }, { status: 400 });
	}

	const normalized = normalizeUrl(url);
	const platformType = detectPlatformType(normalized);

	try {
		const scraped = await scrapeUrl(normalized, {
			youtubeApiKey: env.YOUTUBE_API_KEY,
			kaitoApiKey: env.KAITO_API_KEY,
		});

		let titleCn = '';
		let summaryCn = '';
		if (env.OPENROUTER_API_KEY) {
			const ai = await quickTranslate(scraped.title, scraped.content || '', env.OPENROUTER_API_KEY, model);
			titleCn = ai.titleCn;
			summaryCn = ai.summaryCn;
		}

		return Response.json({
			url: normalized,
			title: scraped.title,
			titleCn,
			summaryCn,
			sourceType: platformType,
			siteName: scraped.siteName,
			author: scraped.author,
			publishedDate: scraped.publishedDate,
		});
	} catch (e) {
		logError('PREVIEW', 'Scrape failed', { url: normalized, error: String(e) });
		return Response.json({ url: normalized, error: `Scrape failed: ${e}` }, { status: 500 });
	}
}
