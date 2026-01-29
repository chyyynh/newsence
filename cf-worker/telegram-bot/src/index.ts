interface Env {
	TELEGRAM_BOT_TOKEN: string;
	CORE: Fetcher; // Service Binding to newsence-core
}

interface TelegramUpdate {
	message?: {
		text?: string;
		from: { id: number; username?: string };
		chat: { id: number };
		entities?: { type: string; offset: number; length: number }[];
	};
}

interface ScrapeResponse {
	success: boolean;
	data?: {
		articleId?: string;
		url: string;
		title: string;
		titleCn?: string;
		content?: string;
		summary?: string;
		summaryCn?: string;
		ogImageUrl?: string | null;
		sourceType: string;
		tags?: string[];
		category?: string;
	};
	alreadyExists?: boolean;
	error?: { code: string; message: string };
}

// Extract URLs from message
function extractUrls(text: string, entities?: { type: string; offset: number; length: number }[]): string[] {
	const urls: string[] = [];

	// From entities (more reliable)
	if (entities) {
		for (const entity of entities) {
			if (entity.type === 'url') {
				urls.push(text.substring(entity.offset, entity.offset + entity.length));
			}
		}
	}

	// Fallback: regex
	if (urls.length === 0) {
		const matches = text.match(/https?:\/\/[^\s]+/g);
		if (matches) urls.push(...matches);
	}

	return urls;
}

// Send message to Telegram (returns message_id)
async function sendMessage(botToken: string, chatId: number, text: string): Promise<number | null> {
	const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: 'HTML',
			disable_web_page_preview: true,
		}),
	});
	if (!response.ok) return null;
	const data = (await response.json()) as { result?: { message_id: number } };
	return data.result?.message_id ?? null;
}

// Edit existing message
async function editMessage(botToken: string, chatId: number, messageId: number, text: string): Promise<boolean> {
	const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			message_id: messageId,
			text,
			parse_mode: 'HTML',
			disable_web_page_preview: true,
		}),
	});
	return response.ok;
}

// Delete message
async function deleteMessage(botToken: string, chatId: number, messageId: number): Promise<void> {
	await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
	});
}

// Send photo with caption to Telegram
async function sendPhoto(botToken: string, chatId: number, photoUrl: string, caption: string): Promise<boolean> {
	const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			photo: photoUrl,
			caption,
			parse_mode: 'HTML',
		}),
	});
	return response.ok;
}

// Format article response (uses Chinese title and summary)
function formatArticleMessage(data: ScrapeResponse['data'], isNew: boolean): string {
	if (!data) return '';

	const status = isNew ? '✅ 已儲存' : '📌 已存在';

	// Use Chinese title if available, fallback to original
	const displayTitle = data.titleCn || data.title;

	let msg = `<b>${status}</b>\n\n`;
	msg += `<b>${displayTitle}</b>\n\n`;

	// Use Chinese summary, fallback to summary, then content
	const bodyText = data.summaryCn || data.summary || data.content;
	if (bodyText) {
		const truncated = bodyText.length > 300 ? bodyText.slice(0, 300) + '...' : bodyText;
		msg += `${truncated}\n\n`;
	}

	if (data.tags && data.tags.length > 0) {
		msg += `🏷️ ${data.tags.slice(0, 5).join(', ')}\n`;
	}

	msg += `🔗 ${data.url}`;

	return msg;
}

// Submit URL to core worker (via Service Binding)
async function scrapeUrl(env: Env, url: string, userId: string): Promise<ScrapeResponse> {
	console.log('[CORE] Calling /scrape for URL:', url);

	try {
		const response = await env.CORE.fetch('https://core/scrape', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url, userId, skipSave: false }),
		});

		const text = await response.text();
		console.log('[CORE] Response status:', response.status);

		try {
			return JSON.parse(text) as ScrapeResponse;
		} catch {
			console.error('[CORE] Invalid JSON response:', text.slice(0, 200));
			return { success: false, error: { code: 'INVALID_RESPONSE', message: `Core error (HTTP ${response.status}): ${text.slice(0, 100)}` } };
		}
	} catch (error) {
		console.error('[CORE] Network error:', error);
		return { success: false, error: { code: 'NETWORK_ERROR', message: String(error) } };
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const payload = (await request.json()) as TelegramUpdate;
		const message = payload.message;

		if (!message?.text) {
			return new Response('ok');
		}

		const chatId = message.chat.id;
		const username = message.from.username || String(message.from.id);

		// Handle /start
		if (message.text === '/start') {
			await sendMessage(
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				'傳送連結給我，我會幫你儲存到 Newsence。\n\n支援：\n- 網頁文章\n- Twitter/X\n- YouTube 影片\n- HackerNews'
			);
			return new Response('ok');
		}

		// Handle /help
		if (message.text === '/help') {
			await sendMessage(
				env.TELEGRAM_BOT_TOKEN,
				chatId,
				'<b>指令：</b>\n' +
					'/start - 開始使用\n' +
					'/help - 顯示說明\n\n' +
					'<b>儲存文章：</b>\n' +
					'直接傳送任何連結，我會自動抓取並儲存。'
			);
			return new Response('ok');
		}

		// Extract URLs from message
		const urls = extractUrls(message.text, message.entities);

		if (urls.length === 0) {
			await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, '找不到連結。請傳送一個網址給我。');
			return new Response('ok');
		}

		// Process each URL
		for (const url of urls) {
			const pendingMsgId = await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `⏳ 正在處理: ${url}`);

			const result = await scrapeUrl(env, url, `telegram_${username}`);

			if (result.success && result.data) {
				const isNew = !result.alreadyExists;
				const msg = formatArticleMessage(result.data, isNew);

				// Has image: delete pending message, send photo
				if (result.data.ogImageUrl) {
					if (pendingMsgId) await deleteMessage(env.TELEGRAM_BOT_TOKEN, chatId, pendingMsgId);
					const photoSent = await sendPhoto(env.TELEGRAM_BOT_TOKEN, chatId, result.data.ogImageUrl, msg);
					if (!photoSent) {
						await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);
					}
				} else if (pendingMsgId) {
					// No image: edit pending message in-place
					const edited = await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, pendingMsgId, msg);
					if (!edited) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);
				} else {
					await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);
				}
			} else {
				const errorMsg = result.error?.message || 'Unknown error';
				const errorText = `❌ 失敗: ${errorMsg}`;
				if (pendingMsgId) {
					const edited = await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, pendingMsgId, errorText);
					if (!edited) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, errorText);
				} else {
					await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, errorText);
				}
			}
		}

		return new Response('ok');
	},
};
