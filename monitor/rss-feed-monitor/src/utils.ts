import keyword_extractor from 'keyword-extractor';
import * as axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenAI, Type } from '@google/genai';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

interface TelegramResponse {
	ok: boolean;
	result: any[];
	description?: string;
}

interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	TELEGRAM_BOT_TOKEN: string;
	TELEGRAM_CHAT_ID: string;
	TELEGRAM_API_ID: string;
	TELEGRAM_API_HASH: string;
	TELEGRAM_SESSION: string;
	GEMINI_API_KEY: string;
}

export async function sendMessageToTelegram(token: string, chatId: string, message: string, options?: Record<string, any>) {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;

	const body: any = {
		chat_id: chatId,
		text: message,
		...options,
	};

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			console.error('Error sending message to Telegram:', response.status, response.statusText);
		}
	} catch (error) {
		console.error('Error sending message to Telegram:', error);
	}
}

export async function tagNews(
	geini_api_key: string,
	title: string,
	content: string
): Promise<{ categories: string[]; keywords: string[]; tokens: string[] }> {
	const ai = new GoogleGenAI({ apiKey: geini_api_key });

	const ai_tag_prompt = `
		You are a crypto-native research analyst. Please analyze the following piece of crypto news and classify it into one or more of the following categories based on its content.

		!Important:
		- Only return the main category name listed before any slashes.
		- Do not include multiple category names in one string (e.g., use "Regulation", not "Regulation / Legal / Compliance").
		- Use only the standardized names listed below.
		- If the news mentions a specific token, include its ticker symbol (e.g., BTC, ETH) in the tokens field.

		## Standardized Categories (choose the most relevant ones, max 3):

		1. Layer1
		2. DeFi
		3. NFT
		4. GameFi
		5. Metaverse
		6. DAO
		7. Regulation
		8. Security
		9. Exchange
		10. Trading
		11. Fundraising
		12. Ecosystem
		13. Community
		14. ETF
		15. Listing

		Category Normalization Guide:

		- "Layer 1 / Layer 2 / Blockchain Infrastructure" → Layer1
		- "DeFi (Decentralized Finance)" → DeFi
		- "NFT / GameFi / Metaverse" → NFT, GameFi, or Metaverse (pick separately)
		- "DAO / Governance" → DAO
		- "Regulation / Legal / Compliance" → Regulation
		- "Hacks / Exploits / Scams / Security Incidents" → Security
		- "Centralized or Decentralized Exchanges (CEX / DEX)" → Exchange
		- "Talking about token price or technical analysis" → Trading
		- "Fundraising / Investments / Venture Capital" → Fundraising
		- "Ecosystem Growth (e.g., Solana, Ethereum, Cosmos, etc.)" → Ecosystem
		- "Community / Airdrops / Governance Proposals / Marketing Campaigns" → Community
		- "ETF (e.g., Spot or Futures-based Exchange Traded Funds)" → ETF
		- "Listings of tokens on exchanges (CEX or DEX)" → Listing

		News content:{{ ${title}\n\n${content} }}`;

	const response = await ai.models.generateContent({
		model: 'gemini-1.5-flash',
		contents: ai_tag_prompt,
		config: {
			responseMimeType: 'application/json',
			responseSchema: {
				type: Type.ARRAY,
				items: {
					type: Type.OBJECT,
					properties: {
						categories: {
							type: Type.ARRAY,
							items: {
								type: Type.STRING,
							},
						},
						keywords: {
							type: Type.ARRAY,
							items: {
								type: Type.STRING,
							},
						},
						tokens: {
							type: Type.ARRAY,
							items: {
								type: Type.STRING,
							},
						},
					},
					propertyOrdering: ['categories', 'keywords', 'tokens'],
				},
			},
		},
	});

	console.log(response.text);
	try {
		const parsed = JSON.parse(response.text ?? '[]');
		if (Array.isArray(parsed)) {
			return parsed[0] as { categories: string[]; keywords: string[]; tokens: string[] };
		}
		return { categories: [], keywords: [], tokens: [] };
	} catch (e) {
		console.error('Failed to parse Gemini response as JSON:', e);
		return { categories: [], keywords: [], tokens: [] };
	}
}

export async function scrapeArticleContent(url: string): Promise<string> {
	try {
		// Add a User-Agent header to mimic a browser request
		console.log(`[Scraper] Scraping content from ${url}...`);
		const headers = {
			'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
		};
		const response = await axios.default.get(url, { headers });
		const html = response.data;
		const $ = cheerio.load(html);
		let content = ''; // for accumulating content
		const title = $('title').text();
		content += `# ${title}\n\n`; // Add title to content
		const elements = $('p, img, a, h1, h2, h3'); // Select relevant elements including h2, h3
		const errors: string[] = []; // Array to collect errors during element processing

		for (const el of elements) {
			try {
				const element = $(el); // Wrap the element with cheerio object
				if (element.is('p')) {
					content += element.text().trim() + '\n\n'; // Accumulate paragraph text
				} else if (element.is('h1')) {
					content += `## ${element.text().trim()}\n\n`;
				} else if (element.is('h2')) {
					content += `### ${element.text().trim()}\n\n`;
				} else if (element.is('h3')) {
					content += `#### ${element.text().trim()}\n\n`;
				} else if (element.is('img')) {
					// Filter out unwanted images based on class
					if (
						!element.hasClass('social-image') &&
						!element.hasClass('navbar-logo') &&
						!element.hasClass('_1sjywpl0 bc5nci19k bc5nci4t0 bc5nci4ow') // mirror pfp class
					) {
						let imgSrc = element.attr('src');

						// Handle relative image URLs
						if (imgSrc && !imgSrc.startsWith('http')) {
							try {
								imgSrc = new URL(imgSrc, url).href; // Convert relative to absolute URL
							} catch (urlError: any) {
								errors.push(`Invalid image URL found: ${imgSrc} - ${urlError.message}`);
								imgSrc = undefined; // Skip invalid URLs
							}
						}

						if (imgSrc) {
							content += `![Image](${imgSrc})\n\n`; // Add image in Markdown format
						}
					}
				}
				// Note: 'a' tags are selected but not explicitly processed, they are ignored.
			} catch (elementError: any) {
				// Catch errors during processing of a single element
				errors.push(`Error processing element: ${elementError.message}`);
				// Optionally log the specific element causing trouble: console.error("Problem element:", $.html(el));
			}
		}

		// Log any collected errors after the loop
		if (errors.length > 0) {
			console.warn(`[Scraper] Encountered ${errors.length} errors while processing elements for ${url}:`);
			errors.forEach((err) => console.warn(` - ${err}`));
		}

		console.log(`[Scraper] Scraped content from ${url} (length: ${content.length})`);
		return content.trim(); // Trim final whitespace
	} catch (error: any) {
		// Handle common scraping errors more gracefully
		if (error.response?.status === 403) {
			console.warn(`[Scraper] Access denied (403) for ${url} - likely protected by bot detection`);
		} else if (error.response?.status === 429) {
			console.warn(`[Scraper] Rate limited (429) for ${url}`);
		} else if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
			console.warn(`[Scraper] Network error for ${url}: ${error.code}`);
		} else {
			console.warn(`[Scraper] Failed to scrape ${url}: ${error.message || error}`);
		}
		return '';
	}
}

// 根據文章 tags 傳送訊息給有相符偏好的使用者：

import { createClient } from '@supabase/supabase-js';

type NotifyOptions = {
	tags: string[];
	title: string;
	summary: string;
	url: string;
};

// Telegram 監控
/*
export async function monitorTgMsg(feed: string) {
	const start = performance.now();
	const apiId = parseInt(env.TELEGRAM_API_ID);
	const apiHash = env.TELEGRAM_API_HASH;
	const sessionString = env.TELEGRAM_SESSION;

	const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });

	try {
		await client.connect();
		// 從 url 欄位獲取 last_message_id，若無則設為 0
		const lastMessageId = feed.url ? parseInt(feed.url) || 0 : 0;
		// 獲取比 lastMessageId 更新的訊息
		const messages = await client.getMessages(feed.RSSLink, {
			limit: 5, // 設置一個合理上限
			minId: lastMessageId, // 只獲取比上次記錄更新的訊息
		});

		if (messages.length === 0) {
			console.log(`[${feed.name}] No new messages since last check (last_message_id: ${lastMessageId})`);
		}

		let latestMessageId = lastMessageId;
		for (const msg of messages) {
			if (msg.text) {
				const telegramItem = {
					message_id: msg.id,
					text: msg.text,
					pubDate: new Date(msg.date * 1000).toISOString(),
				};
				await processAndInsertArticle(supabase, env, telegramItem, feed, 'telegram');
				// 更新最新訊息 ID
				latestMessageId = Math.max(latestMessageId, msg.id);
			}
		}

		// 更新 RssList 表中的 url（作為 last_message_id）和 scraped_at
		const { error: updateError } = await supabase
			.from('RssList')
			.update({
				scraped_at: new Date(),
				url: latestMessageId.toString(), // 將整數轉為字串存入 url
			})
			.eq('id', feed.id);

		if (updateError) {
			console.error(`[${feed.name}] Failed to update RssList:`, updateError);
		} else {
			console.log(`[${feed.name}] Updated RssList table with last_message_id: ${latestMessageId}`);
		}
		const duration = performance.now() - start;
		console.log(`[${feed.name}] Telegram 處理時間: ${duration.toFixed(2)}ms`);
	} catch (telegramError) {
		console.error(`[${feed.name}] Telegram error:`, telegramError);
	} finally {
		await client.disconnect();
	}
}
	*/
