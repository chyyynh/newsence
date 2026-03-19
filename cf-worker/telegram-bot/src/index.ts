interface Env {
	TELEGRAM_BOT_TOKEN: string;
	CORE: Fetcher; // Service Binding to newsence-core
	CORE_WORKER_INTERNAL_TOKEN?: string;
	WEBAPP_URL?: string; // e.g. https://www.newsence.app
}

const DEFAULT_WEBAPP_URL = 'https://www.newsence.app';

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

interface SubmitResponse {
	success: boolean;
	results?: Array<{
		url: string;
		articleId?: string;
		instanceId?: string;
		title?: string;
		ogImageUrl?: string | null;
		sourceType?: string;
		alreadyExists?: boolean;
		isUserArticle?: boolean;
		error?: string;
	}>;
	error?: { code: string; message: string };
}

interface NotifyArticle {
	id: string;
	title: string;
	title_cn?: string;
	summary?: string;
	summary_cn?: string;
	content_cn?: string;
	source: string;
	source_type: string;
	og_image_url?: string | null;
	published_date?: string;
	tags?: string[];
	keywords?: string[];
	url: string;
}

interface NotifyContext {
	chatId: number;
	messageId: number;
	linked: boolean;
	userId: string;
	articleId: string;
	alreadyExists: boolean;
	webappUrl: string;
	isUserArticle?: boolean;
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
async function sendMessageWithKeyboard(botToken: string, chatId: number, text: string, keyboard: InlineKeyboard): Promise<number | null> {
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

// Edit existing message text (optionally with keyboard)
async function editMessageWithKeyboard(
	botToken: string,
	chatId: number,
	messageId: number,
	text: string,
	keyboard?: InlineKeyboard,
): Promise<boolean> {
	const body: Record<string, unknown> = {
		chat_id: chatId,
		message_id: messageId,
		text,
		parse_mode: 'HTML',
		disable_web_page_preview: true,
	};
	if (keyboard) {
		body.reply_markup = { inline_keyboard: keyboard };
	}
	const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return response.ok;
}

// Edit message reply markup (remove keyboard by passing null)
async function editMessageReplyMarkup(
	botToken: string,
	chatId: number,
	messageId: number,
	keyboard: InlineKeyboard | null,
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
	env: Env,
	userId: string,
	articleId: string,
	collectionId: string,
	toType?: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await env.CORE.fetch('https://core/telegram/add-to-collection', {
			method: 'POST',
			headers: coreHeaders(env),
			body: JSON.stringify({ userId, articleId, collectionId, ...(toType ? { toType } : {}) }),
		});
		return (await response.json()) as { success: boolean; error?: string };
	} catch {
		return { success: false, error: 'Network error' };
	}
}

// Find the default collection
function findDefaultCollection(collections: CollectionItem[]): CollectionItem | null {
	return collections.find((c) => c.isDefault) ?? null;
}

// Submit URL to core worker (via Service Binding), with optional notifyContext
async function submitUrlToCore(
	env: Env,
	url: string,
	userId: string,
	notifyContext?: { chatId: number; messageId: number; linked: boolean; userId: string; webappUrl: string },
): Promise<SubmitResponse> {
	try {
		const body: Record<string, unknown> = { url, userId };
		if (notifyContext) body.notifyContext = notifyContext;

		const response = await env.CORE.fetch('https://core/submit', {
			method: 'POST',
			headers: coreHeaders(env),
			body: JSON.stringify(body),
		});

		const text = await response.text();

		try {
			return JSON.parse(text) as SubmitResponse;
		} catch {
			const msg = `Core error (HTTP ${response.status}): ${text.slice(0, 100)}`;
			return { success: false, error: { code: 'INVALID_RESPONSE', message: msg } };
		}
	} catch (error) {
		return { success: false, error: { code: 'NETWORK_ERROR', message: String(error) } };
	}
}

// ─────────────────────────────────────────────────────────────
// Collection keyboard helpers
// ─────────────────────────────────────────────────────────────

function buildCollectionKeyboard(
	otherCollections: CollectionItem[],
	articleId: string,
	webappUrl: string,
	toType = 'article',
): InlineKeyboard {
	const keyboard: InlineKeyboard = [];
	// Encode toType suffix for user_article; omit for article (backward compat)
	const typeSuffix = toType === 'user_article' ? ':ua' : '';

	// Other collections: 2 per row, max 6
	for (let i = 0; i < otherCollections.length; i += 2) {
		const row: InlineKeyboardButton[] = [];
		for (let j = i; j < Math.min(i + 2, otherCollections.length); j++) {
			const col = otherCollections[j];
			const label = col.icon ? `${col.icon} ${col.name}` : col.name;
			row.push({ text: label, callback_data: `col:${col.id}${typeSuffix}` });
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

// Parse articleId from message text (extracted from /p/{articleId} link)
function parseArticleId(text?: string | null): string | null {
	if (!text) return null;
	const match = text.match(/\/p\/([0-9a-f-]{36})/);
	return match?.[1] ?? null;
}

// ─────────────────────────────────────────────────────────────
// Message formatting
// ─────────────────────────────────────────────────────────────

function friendlyError(error: string): string {
	if (error.includes('Tweet not found')) return '找不到這則推文，可能已被刪除或設為私人';
	if (error.includes('rate limit') || error.includes('RATE_LIMIT')) return '請求過於頻繁，請稍後再試';
	if (error.includes('NETWORK_ERROR')) return '網路連線錯誤，請稍後再試';
	return error;
}

interface MessageOpts {
	savedTo?: string;
	linked?: boolean;
	alreadyExists?: boolean;
}

function formatStatusLine(opts: MessageOpts): string {
	if (opts.alreadyExists) {
		return opts.savedTo ? `文章已存在，已儲存到「${opts.savedTo}」` : '文章已存在';
	}
	return opts.savedTo ? `已儲存到「${opts.savedTo}」` : '已儲存';
}

function formatLinks(originalUrl: string, webappUrl: string, articleId?: string): string {
	if (articleId) return `${webappUrl}/p/${articleId} - <a href="${originalUrl}">原文</a>`;
	return `<a href="${originalUrl}">原文</a>`;
}

function formatFooter(opts: MessageOpts): string {
	let footer = '';
	if (opts.savedTo) footer += `\n\n${formatStatusLine(opts)}`;
	if (!opts.linked) footer += '\n\n使用 /link 綁定帳號，可自動加入收藏夾';
	return footer;
}

function formatBasicResult(result: NonNullable<SubmitResponse['results']>[0], webappUrl: string, opts: MessageOpts): string {
	let msg = '';
	if (result.title) msg += `<b>${result.title}</b>\n\n`;
	if (result.sourceType) msg += `${result.sourceType}\n\n`;
	msg += formatLinks(result.url, webappUrl, result.articleId);
	msg += formatFooter(opts);
	return msg;
}

function formatAIResult(article: NotifyArticle, articleId: string, webappUrl: string, opts: MessageOpts): string {
	const title = article.title_cn || article.title;
	let msg = `<b>${title}</b>\n\n`;
	const body = article.summary_cn || article.summary;
	if (body) msg += `${body}\n\n`;
	if (article.source_type) {
		msg += article.source_type;
		if (article.tags && article.tags.length > 0) msg += ` · ${article.tags.slice(0, 3).join(', ')}`;
		msg += '\n\n';
	}
	msg += formatLinks(article.url, webappUrl, articleId);
	msg += formatFooter(opts);
	return msg;
}

// ─────────────────────────────────────────────────────────────
// Resolve userId
// ─────────────────────────────────────────────────────────────

async function resolveUser(env: Env, telegramId: string, username: string): Promise<{ userId: string; linked: boolean }> {
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
			`👤 <b>${firstName}</b>\n\n✅ 帳號已綁定\n透過 Bot 儲存的文章會自動歸到你的 newsence 帳號。`,
		);
	} else {
		const webappUrl = env.WEBAPP_URL || DEFAULT_WEBAPP_URL;
		await sendMessage(
			env.TELEGRAM_BOT_TOKEN,
			chatId,
			`👤 <b>${firstName}</b>\n\n⚠️ 帳號尚未綁定\n你可以到 newsence 設定頁面綁定 Telegram 帳號。\n\n🔗 ${webappUrl}`,
		);
	}
}

// Compute Telegram Login-compatible HMAC-SHA256 hash (Web Crypto API)
async function computeTelegramHash(botToken: string, data: Record<string, string | number>): Promise<string> {
	const checkString = Object.entries(data)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join('\n');

	const secretKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(botToken));
	const cryptoKey = await crypto.subtle.importKey('raw', secretKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(checkString));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleLink(env: Env, chatId: number, telegramId: string, firstName: string, username: string): Promise<void> {
	const lookup = await lookupTelegramAccount(env, telegramId);
	const webappUrl = env.WEBAPP_URL || DEFAULT_WEBAPP_URL;

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
		`🔗 <b>綁定 Telegram 帳號</b>\n\n點擊下方連結完成綁定（15 分鐘內有效）：\n\n👉 ${linkUrl}`,
	);
}

// ─────────────────────────────────────────────────────────────
// URL submission flow (push-based, no polling)
// ─────────────────────────────────────────────────────────────

async function autoSaveToCollection(
	env: Env,
	userId: string,
	articleId: string,
	toType?: string,
): Promise<{ savedTo?: string; collections: CollectionItem[]; defaultCol: CollectionItem | null }> {
	const collections = await fetchUserCollections(env, userId);
	const defaultCol = findDefaultCollection(collections);
	let savedTo: string | undefined;

	if (defaultCol) {
		const addResult = await addToCollection(env, userId, articleId, defaultCol.id, toType);
		if (addResult.success) {
			savedTo = `${defaultCol.icon || '📚'} ${defaultCol.name}`;
		}
	}

	return { savedTo, collections, defaultCol };
}

const MESSAGE_LIMIT = 4096;

function truncateMessage(msg: string): string {
	return msg.length > MESSAGE_LIMIT ? `${msg.slice(0, MESSAGE_LIMIT - 3)}...` : msg;
}

async function processSingleUrl(
	env: Env,
	chatId: number,
	url: string,
	userId: string,
	linked: boolean,
	webappUrl: string,
): Promise<void> {
	// 1. Send "正在處理" → pendingMsgId
	const pendingMsgId = await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `正在處理: ${url}`);

	// 2. Build notifyContext (only if we got a message id to edit later)
	const notifyCtx = pendingMsgId
		? { chatId, messageId: pendingMsgId, linked, userId, webappUrl }
		: undefined;

	// 3. Submit to core with notifyContext
	const submitResult = await submitUrlToCore(env, url, userId, notifyCtx);

	if (!submitResult.success || !submitResult.results?.length) {
		await editOrSend(env, chatId, pendingMsgId, friendlyError(submitResult.error?.message || 'Unknown error'));
		return;
	}

	const result = submitResult.results[0];
	if (result.error) {
		await editOrSend(env, chatId, pendingMsgId, friendlyError(result.error));
		return;
	}

	const articleId = result.articleId;
	const toType = result.isUserArticle ? 'user_article' : 'article';

	// 4. Auto-save to default collection
	let savedTo: string | undefined;
	let otherCols: CollectionItem[] = [];
	if (linked && articleId) {
		const auto = await autoSaveToCollection(env, userId, articleId, toType);
		savedTo = auto.savedTo;
		otherCols = auto.collections.filter((c) => c.id !== auto.defaultCol?.id);
	}

	const msgOpts: MessageOpts = { savedTo, linked, alreadyExists: result.alreadyExists };

	// 5. Edit pendingMsg to basic result + keyboard (no polling, AI result comes via /notify)
	const msg = truncateMessage(formatBasicResult(result, webappUrl, msgOpts));
	const keyboard = linked && articleId ? buildCollectionKeyboard(otherCols, articleId, webappUrl, toType) : undefined;

	if (pendingMsgId) {
		const edited = await editMessageWithKeyboard(env.TELEGRAM_BOT_TOKEN, chatId, pendingMsgId, msg, keyboard);
		if (!edited) {
			// Fallback: send new message
			if (keyboard) {
				await sendMessageWithKeyboard(env.TELEGRAM_BOT_TOKEN, chatId, msg, keyboard);
			} else {
				await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);
			}
		}
	} else if (keyboard) {
		await sendMessageWithKeyboard(env.TELEGRAM_BOT_TOKEN, chatId, msg, keyboard);
	} else {
		await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, msg);
	}
}

async function handleUrlSubmission(
	env: Env,
	chatId: number,
	urls: string[],
	telegramId: string,
	username: string,
): Promise<void> {
	await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId, 'typing');
	const { userId, linked } = await resolveUser(env, telegramId, username);
	const webappUrl = env.WEBAPP_URL || DEFAULT_WEBAPP_URL;

	for (const url of urls) {
		await processSingleUrl(env, chatId, url, userId, linked, webappUrl);
	}
}

// Edit pending message or send new one
async function editOrSend(env: Env, chatId: number, pendingMsgId: number | null, text: string): Promise<void> {
	if (pendingMsgId) {
		const edited = await editMessageWithKeyboard(env.TELEGRAM_BOT_TOKEN, chatId, pendingMsgId, text);
		if (!edited) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
	} else {
		await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text);
	}
}

// ─────────────────────────────────────────────────────────────
// Callback query handler (collection selection)
// ─────────────────────────────────────────────────────────────

async function handleCollectionSelect(
	env: Env,
	queryId: string,
	from: { id: number },
	message: NonNullable<TelegramUpdate['callback_query']>['message'],
	collectionId: string,
	toType?: string,
): Promise<void> {
	const articleId = parseArticleId(message?.text || message?.caption);
	const lookup = await lookupTelegramAccount(env, String(from.id));

	if (!(lookup.found && lookup.userId && articleId)) {
		await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, '無法處理');
		return;
	}

	const result = await addToCollection(env, lookup.userId, articleId, collectionId, toType);
	if (result.success) {
		await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, '✓ 已加入收藏');
	} else if (result.error === 'already_exists') {
		await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, '已在此收藏中');
	} else {
		await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, '操作失敗');
	}
}

async function handleCallbackQuery(env: Env, query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
	const { id, data, message, from } = query;
	if (!data || !message) {
		await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id);
		return;
	}

	const chatId = message.chat.id;
	const messageId = message.message_id;

	if (data.startsWith('done:')) {
		await editMessageReplyMarkup(env.TELEGRAM_BOT_TOKEN, chatId, messageId, null);
		await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id, '完成');
		return;
	}

	if (data.startsWith('col:')) {
		// Format: col:{collectionId} or col:{collectionId}:ua
		const payload = data.slice(4);
		const uaSuffix = payload.endsWith(':ua');
		const collectionId = uaSuffix ? payload.slice(0, -3) : payload;
		const toType = uaSuffix ? 'user_article' : undefined;
		await handleCollectionSelect(env, id, from, message, collectionId, toType);
		return;
	}

	await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, id);
}

// ─────────────────────────────────────────────────────────────
// /notify handler (push from core worker workflow)
// ─────────────────────────────────────────────────────────────

function isInternalAuthorized(request: Request, env: Env): boolean {
	const expected = env.CORE_WORKER_INTERNAL_TOKEN?.trim();
	if (!expected) return false;
	const provided = request.headers.get('x-internal-token')?.trim();
	if (!provided) return false;
	// Simple equality — both workers are internal, no timing-attack risk
	return provided === expected;
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
	if (!isInternalAuthorized(request, env)) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: { article?: NotifyArticle; notifyContext?: NotifyContext };
	try {
		body = (await request.json()) as { article?: NotifyArticle; notifyContext?: NotifyContext };
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const { article, notifyContext } = body;
	if (!article || !notifyContext) {
		return Response.json({ error: 'Missing article or notifyContext' }, { status: 400 });
	}

	const { chatId, messageId, linked, userId, articleId, webappUrl, isUserArticle } = notifyContext;
	const notifyToType = isUserArticle ? 'user_article' : 'article';

	// Build message opts: re-fetch collections for keyboard if linked
	let savedTo: string | undefined;
	let otherCols: CollectionItem[] = [];
	if (linked) {
		const collections = await fetchUserCollections(env, userId);
		const defaultCol = findDefaultCollection(collections);
		if (defaultCol) {
			savedTo = `${defaultCol.icon || '📚'} ${defaultCol.name}`;
		}
		otherCols = collections.filter((c) => c.id !== defaultCol?.id);
	}

	const msgOpts: MessageOpts = { savedTo, linked, alreadyExists: notifyContext.alreadyExists };
	const msg = truncateMessage(formatAIResult(article, articleId, webappUrl, msgOpts));
	const keyboard = linked ? buildCollectionKeyboard(otherCols, articleId, webappUrl, notifyToType) : undefined;

	await editMessageWithKeyboard(env.TELEGRAM_BOT_TOKEN, chatId, messageId, msg, keyboard);

	return Response.json({ ok: true });
}

// ─────────────────────────────────────────────────────────────
// Telegram webhook handler
// ─────────────────────────────────────────────────────────────

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
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
}

// ─────────────────────────────────────────────────────────────
// Main fetch handler (path-based routing)
// ─────────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Internal /notify endpoint (push from core worker)
		if (url.pathname === '/notify' && request.method === 'POST') {
			return handleNotify(request, env);
		}

		// Everything else is the Telegram webhook
		return handleTelegramWebhook(request, env);
	},
};
