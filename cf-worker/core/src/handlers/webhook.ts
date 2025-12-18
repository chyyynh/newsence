import { Env, ExecutionContext } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { normalizeUrl } from '../utils/rss';

function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles_test_core';
}

async function processWebSocketMessage(
	supabase: any,
	env: Env,
	message: any
) {
	const table = getArticlesTable(env);
	const url = message.url ? normalizeUrl(message.url) : `websocket:${Date.now()}`;

	const insert = {
		url,
		title: message.title || message.text || 'WebSocket Message',
		source: message.source_name || 'WebSocket Source',
		published_date: message.published_date ? new Date(message.published_date) : new Date(),
		scraped_date: new Date(),
		keywords: [],
		tags: [],
		tokens: [],
		summary: message.summary || '',
		source_type: 'websocket',
		content: message.content || message.text || '',
		og_image_url: message.og_image_url || null,
	};

	console.log(`[WEBHOOK] Inserting WebSocket message: ${insert.title}`);

	const { data: insertedData, error: insertError } = await supabase
		.from(table)
		.insert([insert])
		.select('id');

	if (insertError) {
		console.error('[WEBHOOK] Insert error:', insertError);
		throw insertError;
	}

	console.log(`[WEBHOOK] ✅ Inserted message: ${insert.title}`);

	// Send to workflow for processing
	if (insertedData && insertedData.length > 0) {
		try {
			await env.RSS_QUEUE.send({
				type: 'article_scraped',
				article_id: insertedData[0].id,
				url: insert.url,
				source: insert.source,
				source_type: 'websocket',
				timestamp: new Date().toISOString(),
			});
			console.log(`[WEBHOOK] 📨 Sent queue message for article: ${insertedData[0].id}`);
		} catch (queueError) {
			console.error('[WEBHOOK] Failed to send queue message:', queueError);
		}
	}
}

export async function handleWebhook(
	request: Request,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	try {
		// Parse JSON payload
		const message: any = await request.json();

		// Validate message
		if (!message || typeof message !== 'object') {
			console.warn('[WEBHOOK] Invalid data format');
			return new Response('Bad Request: Invalid JSON payload', { status: 400 });
		}

		console.log('[WEBHOOK] Received message:', message);

		const supabase = getSupabaseClient(env);

		// Process async with waitUntil
		ctx.waitUntil(processWebSocketMessage(supabase, env, message));

		return new Response(
			JSON.stringify({
				status: 'received',
				message: 'Message queued for processing.',
			}),
			{
				status: 202,
				headers: { 'Content-Type': 'application/json' },
			}
		);
	} catch (error: any) {
		if (error instanceof SyntaxError) {
			console.error('[WEBHOOK] JSON parsing error:', error);
			return new Response('Bad Request: Could not parse JSON.', { status: 400 });
		}

		console.error('[WEBHOOK] Processing error:', error);
		return new Response('Internal Server Error', { status: 500 });
	}
}
