import { detectPlatformType, scrapeUrl } from '../../domain/scrapers';
import { ARTICLES_TABLE, createDbClient, USER_ARTICLES_TABLE } from '../../infra/db';
import { logError, logWarn } from '../../infra/log';
import { callOpenRouter, extractJson } from '../../infra/openrouter';
import { normalizeUrl } from '../../infra/web';
import type { Env } from '../../models/types';
import { isSubmitAuthorized } from '../middleware/auth';
import { processUrl } from './submit';

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
	save?: boolean;
	model?: string;
};

export async function handlePreview(request: Request, env: Env): Promise<Response> {
	if (!(await isSubmitAuthorized(request, env))) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	let url: string | null = null;
	let save = false;
	let model = PREVIEW_DEFAULT_MODEL;

	if (request.method === 'GET') {
		const params = new URL(request.url).searchParams;
		url = params.get('url');
		save = params.get('save') === 'true';
		model = params.get('model') || model;
	} else {
		let body: PreviewBody;
		try {
			body = (await request.json()) as PreviewBody;
		} catch {
			return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
		}
		url = body.url ?? (body.message ? extractUrl(body.message) : null);
		save = body.save ?? false;
		model = body.model || model;
	}

	if (!url) {
		return Response.json({ error: 'Missing url (or no URL found in message)' }, { status: 400 });
	}

	const normalized = normalizeUrl(url);
	const platformType = detectPlatformType(normalized);

	if (save) {
		// Save mode: full submit flow (scrape + DB + workflow) then quick AI preview
		const submitResult = await processUrl(url, env);
		if (submitResult.error) return Response.json(submitResult, { status: 500 });
		if (submitResult.titleCn && submitResult.summaryCn) return Response.json(submitResult);

		// Read content from DB (avoid double-scrape) for quick translate
		if (env.OPENROUTER_API_KEY && submitResult.articleId) {
			const db = await createDbClient(env);
			try {
				const table = submitResult.isUserArticle ? USER_ARTICLES_TABLE : ARTICLES_TABLE;
				const r = await db.query(`SELECT title, content FROM ${table} WHERE id = $1`, [submitResult.articleId]);
				const row = r.rows[0] as { title: string; content: string } | undefined;
				if (row?.content) {
					const ai = await quickTranslate(row.title, row.content, env.OPENROUTER_API_KEY, model);
					return Response.json({ ...submitResult, ...ai });
				}
			} catch (e) {
				logWarn('PREVIEW', 'Quick translate failed', { error: String(e) });
			} finally {
				await db.end();
			}
		}
		return Response.json(submitResult);
	}

	// Preview-only mode: scrape + AI, no DB
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
