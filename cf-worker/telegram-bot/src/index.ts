interface Env {
	TELEGRAM_BOT_TOKEN: string;
	CORE: Fetcher; // Service Binding to newsence-core
	CORE_WORKER_INTERNAL_TOKEN?: string;
	WEBAPP_URL?: string; // e.g. https://app.newsence.xyz
}

interface TelegramUpdate {
	message?: {
		text?: string;
		from: { id: number; username?: string; first_name?: string };
		chat: { id: number };
		entities?: { type: string; offset: number; length: number }[];
	};
	callback_query?: {
		id: string;
		from: { id: number; username?: string; first_name?: string };
		message?: {
			message_id: number;
			chat: { id: number };
			text?: string;
			caption?: string;
		};
		data?: string;
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

interface TelegramLookupResponse {
	found: boolean;
	userId?: string;
}

interface CollectionItem {
	id: string;
	name: string;
	icon: string | null;
	isDefault: boolean;
	isSystem: boolean;
}

type InlineKeyboardButton = { text: string; callback_data: string } | { text: string; url: string };
type InlineKeyboard = InlineKeyboardButton[][];

// ─────────────────────────────────────────────────────────────
// Telegram API helpers
// ─────────────────────────────────────────────────────────────

// Send typing indicator
async function sendChatAction(botToken: string, chatId: number, action: string): Promise<void> {
	await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, action }),
	});
}

// Extract URLs from message
function extractUrls(text: string, entities?: { type: string; offset: number; length: number }[]): string[] {
	const urls: string[] = [];

	if (entities) {
		for (const entity of entities) {
			if (entity.type === 'url') {
				urls.push(text.substring(entity.offset, entity.offset + entity.length));
			}
		}
	}

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

// Send message with inline keyboard
async function sendMessageWithKeyboard(
	botToken: string, chatId: number, text: string, keyboard: InlineKeyboard,
): Promise<number | null> {
	const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: 'HTML',
			disable_web_page_preview: true,
			reply_markup: { inline_keyboard: keyboard },
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

// Edit message reply markup (remove keyboard by passing null)
async function editMessageReplyMarkup(
	botToken: string, chatId: number, messageId: number, keyboard: InlineKeyboard | null,
): Promise<boolean> {
	const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			message_id: messageId,
			reply_markup: keyboard ? { inline_keyboard: keyboard } : { inline_keyboard: [] },
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

// Send photo with caption and inline keyboard
async function sendPhotoWithKeyboard(
	botToken: string, chatId: number, photoUrl: string, caption: string, keyboard: InlineKeyboard,
): Promise<boolean> {
	const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			photo: photoUrl,
			caption,
			parse_mode: 'HTML',
			reply_markup: { inline_keyboard: keyboard },
		}),
	});
	return response.ok;
}

// Answer callback query (acknowledge button press)
async function answerCallbackQuery(botToken: string, queryId: string, text?: string): Promise<void> {
	await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			callback_query_id: queryId,
			text,
		}),
	});
}

// ─────────────────────────────────────────────────────────────
// Core worker API helpers
// ─────────────────────────────────────────────────────────────

function coreHeaders(env: Env): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		...(env.CORE_WORKER_INTERNAL_TOKEN ? { 'X-Internal-Token': env.CORE_WORKER_INTERNAL_TOKEN } : {}),
	};
}

// Lookup Telegram account binding via core worker
async function lookupTelegramAccount(env: Env, telegramId: string): Promise<TelegramLookupResponse> {
	try {
		const response = await env.CORE.fetch('https://core/telegram/lookup', {
			method: 'POST',
			headers: coreHeaders(env),
			body: JSON.stringify({ telegramId }),
		});
		if (!response.ok) return { found: false };
		return (await response.json()) as TelegramLookupResponse;
	} catch {
		return { found: false };
	}
}

// Fetch user collections from core worker
async function fetchUserCollections(env: Env, userId: string): Promise<CollectionItem[]> {
	try {
		const response = await env.CORE.fetch('https://core/telegram/collections', {
			method: 'POST',
			headers: coreHeaders(env),
			body: JSON.stringify({ userId }),
		});
		if (!response.ok) return [];
		const data = (await response.json()) as { collections: CollectionItem[] };
		return data.collections ?? [];
	} catch {
		return [];
	}
}

// Add article to collection via core worker
async function addToCollection(
	env: Env, userId: string, articleId: string, collectionId: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await env.CORE.fetch('https://core/telegram/add-to-collection', {
			method: 'POST',
			headers: coreHeaders(env),
			body: JSON.stringify({ userId, articleId, collectionId }),
		});
		return (await response.json()) as { success: boolean; error?: string };
	} catch {
		return { success: false, error: 'Network error' };
	}
}

// Find the default collection: isDefault > isSystem > null
function findDefaultCollection(collections: CollectionItem[]): CollectionItem | null {
	return collections.find((c) => c.isDefault) ?? collections.find((c) => c.isSystem) ?? null;
}

// Submit URL to core worker (via Service Binding)
async function submitUrlToCore(env: Env, url: string, userId: string): Promise<ScrapeResponse> {
	console.log('[CORE] Calling /submit for URL:', url);

	try {
		const response = await env.CORE.fetch('https://core/submit', {
			method: 'POST',
			headers: coreHeaders(env),
			body: JSON.stringify({ url, userId }),
		});

		const text = await response.text();
		console.log('[CORE] Response status:', response.status);

		try {
			return JSON.parse(text) as ScrapeResponse;
		} catch {
			console.error('[CORE] Invalid JSON response:', text.slice(0, 200));
			const msg = `Core error (HTTP ${response.status}): ${text.slice(0, 100)}`;
			return { success: false, error: { code: 'INVALID_RESPONSE', message: msg } };
		}
	} catch (error) {
		console.error('[CORE] Network error:', error);
		return { success: false, error: { code: 'NETWORK_ERROR', message: String(error) } };
	}
}

// ─────────────────────────────────────────────────────────────
// Collection keyboard helpers
// ─────────────────────────────────────────────────────────────

function buildCollectionKeyboard(
	otherCollections: CollectionItem[], articleId: string, webappUrl: string,
): InlineKeyboard {
	const keyboard: InlineKeyboard = [];

	// Other collections: 2 per row, max 6
	for (let i = 0; i < otherCollections.length; i += 2) {
		const row: InlineKeyboardButton[] = [];
		for (let j = i; j < Math.min(i + 2, otherCollections.length); j++) {
			const col = otherCollections[j];
			const label = col.icon ? `${col.icon} ${col.name}` : col.name;
			row.push({ text: label, callback_data: `col:${col.id}` });
		}
		keyboard.push(row);
	}

	// "新增收藏夾" URL button (always shown)
	keyboard.push([{ text: '➕ 新增收藏夾', url: webappUrl }]);

	// "完成" button (only when there are other collections to pick)
	if (otherCollections.length > 0) {
		keyboard.push([{ text: '✅ 完成', callback_data: `done:${articleId}` }]);
	}

	return keyboard;
}

// Parse articleId from message text (hidden marker: 📎 {articleId})
function parseArticleId(text?: string | null): string | null {
	if (!text) return null;
	const match = text.match(/📎\s*([0-9a-f-]{36})/);
	return match?.[1] ?? null;
}

// ─────────────────────────────────────────────────────────────
// Message formatting
// ─────────────────────────────────────────────────────────────

function formatArticleMessage(
	data: ScrapeResponse['data'], articleId?: string, savedTo?: string,
): string {
	if (!data) return '';

	const status = savedTo ? `✅ 已儲存到「${savedTo}」` : '✅ 已儲存';
	const displayTitle = data.titleCn || data.title;

	let msg = `${status}\n\n`;
	msg += `<b>${displayTitle}</b>\n`;

	if (data.sourceType) {
		msg += `📂 ${data.sourceType}`;
		if (data.tags && data.tags.length > 0) {
			msg += ` · ${data.tags.slice(0, 3).join(', ')}`;
		}
		msg += '\n';
	}

	msg += '\n';

	const bodyText = data.summaryCn || data.summary || data.content;
	if (bodyText) {
		const truncated = bodyText.length > 200 ? bodyText.slice(0, 200) + '...' : bodyText;
		msg += `${truncated}\n\n`;
	}

	msg += `🔗 ${data.url}`;

	// Hidden articleId marker for callback parsing
	if (articleId) {
		msg += `\n📎 ${articleId}`;
	}

	return msg;
}

// ─────────────────────────────────────────────────────────────
// Resolve userId
// ─────────────────────────────────────────────────────────────

async function resolveUser(
	env: Env, telegramId: string, username: string,
): Promise<{ userId: string; linked: boolean }> {
	const lookup = await lookupTelegramAccount(env, telegramId);
	if (lookup.found && lookup.userId) return { userId: lookup.userId, linked: true };
	return { userId: `telegram_${username}`, linked: false };
}

// ─────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────

async function handleStart(env: Env, chatId: number): Promise<void> {
	await sendMessage(
		env.TELEGRAM_BOT_TOKEN,
		chatId,
		'👋 歡迎使用 <b>newsence</b> Bot！\n\n' +
			'傳送連結給我，我會幫你儲存到 newsence。\n\n' +
			'<b>支援格式：</b>\n' +
			'• 網頁文章\n' +
			'• Twitter/X\n' +
			'• YouTube 影片\n' +
			'• HackerNews\n\n' +
			'<b>指令：</b>\n' +
			'/me — 查看帳號綁定狀態\n' +
			'/link — 綁定 newsence 帳號\n' +
			'/help — 顯示說明',
	);
}

async function handleHelp(env: Env, chatId: number): Promise<void> {
	await sendMessage(
		env.TELEGRAM_BOT_TOKEN,
		chatId,
		'<b>指令：</b>\n' +
			'/start — 開始使用\n' +
			'/me — 查看帳號綁定狀態\n' +
			'/link — 綁定 newsence 帳號\n' +
			'/help — 顯示說明\n\n' +
			'<b>儲存文章：</b>\n' +
			'直接傳送任何連結，我會自動抓取並儲存。\n\n' +
			'<b>綁定帳號後：</b>\n' +
			'透過 Bot 儲存的文章會歸到你的 newsence 帳號下。',
	);
}

async function handleMe(env: Env, chatId: number, telegramId: string, firstName: string): Promise<void> {
	const lookup = await lookupTelegramAccount(env, telegramId);

	if (lookup.found) {
		await sendMessage(
			env.TELEGRAM_BOT_TOKEN,
			chatId,
			`👤 <b>${firstName}</b>\n\n` +
				'✅ 帳號已綁定\n' +
				'透過 Bot 儲存的文章會自動歸到你的 newsence 帳號。',
		);
	} else {
		const webappUrl = env.WEBAPP_URL || 'https://app.newsence.xyz';
		await sendMessage(
			env.TELEGRAM_BOT_TOKEN,
			chatId,
			`👤 <b>${firstName}</b>\n\n` +
				'⚠️ 帳號尚未綁定\n' +
				'你可以到 newsence 設定頁面綁定 Telegram 帳號。\n\n' +
				`🔗 ${webappUrl}`,
		);
	}
}

// Compute Telegram Login-compatible HMAC-SHA256 hash (Web Crypto API)
async function computeTelegramHash(
	botToken: string,
	data: Record<string, string | number>,
): Promise<string> {
	const checkString = Object.entries(data)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join('\n');

	const secretKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botToken));
	const cryptoKey = await crypto.subtle.importKey('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(checkString));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleLink(
	env: Env,
	chatId: number,
	telegramId: string,
	firstName: string,
	username: string,
): Promise<void> {
	const lookup = await lookupTelegramAccount(env, telegramId);
	const webappUrl = env.WEBAPP_URL || 'https://app.newsence.xyz';

	if (lookup.found) {
		await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, '✅ 你的 Telegram 帳號已經綁定 newsence 了！');
		return;
	}

	const authDate = Math.floor(Date.now() / 1000);
	const payload: Record<string, string | number> = {
		id: Number(telegramId),
		first_name: firstName,
		auth_date: authDate,
	};
	if (username !== telegramId) {
		payload.username = username;
	}
	const hash = await computeTelegramHash(env.TELEGRAM_BOT_TOKEN, payload);

	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(payload)) {
		params.set(k, String(v));
	}
	params.set('hash', hash);

	const linkUrl = `${webappUrl}/link-telegram?${params.toString()}`;

	await sendMessage(
		env.TELEGRAM_BOT_TOKEN,
		chatId,
		'🔗 <b>綁定 Telegram 帳號</b>\n\n' +
			'點擊下方連結完成綁定（15 分鐘內有效）：\n\n' +
			`👉 ${linkUrl}`,
	);
}

// ─────────────────────────────────────────────────────────────
// URL submission flow
// ─────────────────────────────────────────────────────────────

async function handleUrlSubmission(
	env: Env,
	chatId: number,
	urls: string[],
	telegramId: string,
	username: string,
): Promise<void> {
	await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, 'typing');
	const { userId, linked } = await resolveUser(env, telegramId, username);
	const webappUrl = env.WEBAPP_URL || 'https://app.newsence.xyz';

	for (const url of urls) {
		const pendingMsgId = await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `⏳ 正在處理: ${url}`);
		const result = await submitUrlToCore(env, url, userId);

		if (!result.success || !result.data) {
			const errorText = `❌ 失敗: ${result.error?.message || 'Unknown error'}`;
			await editOrSend(env, chatId, pendingMsgId, errorText);
			continue;
		}

		const articleId = result.data.articleId;
		const showKeyboard = linked && articleId;

		if (!showKeyboard) {
			const msg = formatArticleMessage(result.data);
			await sendArticleResult(env, chatId, pendingMsgId, msg, result.data.ogImageUrl);
			continue;
		}

		// Linked user with articleId: auto-save to default collection
		const collections = await fetchUserCollections(env, userId);
		const defaultCol = findDefaultCollection(collections);
		let savedTo: string | undefined;

		if (defaultCol) {
			const addResult = await addToCollection(env, userId, articleId!, defaultCol.id);
			if (addResult.success) {
				const icon = defaultCol.icon || '📚';
				savedTo = `${icon} ${defaultCol.name}`;
			}
		}

		const otherCols = collections.filter((c) => !c.isSystem && c.id !== defaultCol?.id);
		const msg = formatArticleMessage(result.data, articleId, savedTo);
		const keyboard = buildCollectionKeyboard(otherCols, articleId!, webappUrl);
		await sendArticleWithKeyboard(env, chatId, pendingMsgId, msg, result.data.ogImageUrl, keyboard);
	}
}

// Send article result with keyboard
async function sendArticleWithKeyboard(
	env: Env,
	chatId: number,
	pendingMsgId: number | null,
	msg: string,
	ogImageUrl: string | null | undefined,
	keyboard: InlineKeyboard,
): Promise<void> {
	if (pendingMsgId) await deleteMessage(env.TELEGRAM_BOT_TOKEN, chatId, pendingMsgId);

	if (ogImageUrl) {
		const sent = await sendPhotoWithKeyboard(env.TELEGRAM_BOT_TOKEN, chatId, ogImageUrl, msg, keyboard);
		if (!sent) await sendMessageWithKeyboard(env.TELEGRAM_BOT_TOKEN, chatId, msg, keyboard);
	} else {
		await sendMessageWithKeyboard(env.TELEGRAM_BOT_TOKEN, chatId, msg, keyboard);
	}
}

// Send article result without keyboard (original behavior)
async function sendArticleResult(
	env: Env,
	chatId: number,
	pendingMsgId: number | null,
	msg: string,
	ogImageUrl?: string | null,
): Promise<void> {
	if (ogImageUrl) {
		if (pendingMsgId) await deleteMessage(env.TELEGRAM_BOT_TOKEN, chatId, pendingMsgId);
		const photoSent = await sendPhoto(env.TELEGRAM_BOT_TOKEN, chatId, ogImageUrl, msg);
		if (!photoSent) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);
	} else {
		await editOrSend(env, chatId, pendingMsgId, msg);
	}
}

// Edit pending message or send new one
async function editOrSend(env: Env, chatId: number, pendingMsgId: number | null, text: string): Promise<void> {
	if (pendingMsgId) {
		const edited = await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, pendingMsgId, text);
		if (!edited) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
	} else {
		await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
	}
}

// ─────────────────────────────────────────────────────────────
// Callback query handler (collection selection)
// ─────────────────────────────────────────────────────────────

async function handleCallbackQuery(env: Env, query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
	const { id, data, message, from } = query;
	if (!data || !message) {
		await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id);
		return;
	}

	const chatId = message.chat.id;
	const messageId = message.message_id;

	// "Done" button — remove keyboard
	if (data.startsWith('done:')) {
		await editMessageReplyMarkup(env.TELEGRAM_BOT_TOKEN, chatId, messageId, null);
		await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id, '完成');
		return;
	}

	// Collection selection
	if (data.startsWith('col:')) {
		const collectionId = data.slice(4);
		const articleId = parseArticleId(message.text || message.caption);
		const lookup = await lookupTelegramAccount(env, String(from.id));

		if (lookup.found && lookup.userId && articleId) {
			const result = await addToCollection(env, lookup.userId, articleId, collectionId);
			if (result.success) {
				await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id, '✓ 已加入收藏');
			} else if (result.error === 'already_exists') {
				await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id, '已在此收藏中');
			} else {
				await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id, '操作失敗');
			}
		} else {
			await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id, '無法處理');
		}
		return;
	}

	await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id);
}

// ─────────────────────────────────────────────────────────────
// Main fetch handler
// ─────────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const payload = (await request.json()) as TelegramUpdate;

		// Handle callback queries (inline keyboard button presses)
		if (payload.callback_query) {
			await handleCallbackQuery(env, payload.callback_query);
			return new Response('ok');
		}

		const message = payload.message;

		if (!message?.text) {
			return new Response('ok');
		}

		const chatId = message.chat.id;
		const telegramId = String(message.from.id);
		const username = message.from.username || telegramId;
		const firstName = message.from.first_name || username;

		// Handle commands
		if (message.text === '/start') {
			await handleStart(env, chatId);
			return new Response('ok');
		}

		if (message.text === '/help') {
			await handleHelp(env, chatId);
			return new Response('ok');
		}

		if (message.text === '/me') {
			await handleMe(env, chatId, telegramId, firstName);
			return new Response('ok');
		}

		if (message.text === '/link') {
			await handleLink(env, chatId, telegramId, firstName, username);
			return new Response('ok');
		}

		// Extract URLs from message
		const urls = extractUrls(message.text, message.entities);

		if (urls.length === 0) {
			await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, '找不到連結。請傳送一個網址給我。');
			return new Response('ok');
		}

		// Process URLs
		await handleUrlSubmission(env, chatId, urls, telegramId, username);
		return new Response('ok');
	},
};
