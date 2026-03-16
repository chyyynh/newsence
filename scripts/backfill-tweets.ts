/**
 * Backfill historical tweets for tracked users.
 *
 * Usage:
 *   KAITO_API_KEY=xxx OPENROUTER_API_KEY=xxx DATABASE_URL=xxx npx tsx scripts/backfill-tweets.ts [--dry-run] [--user=karpathy] [--days=30]
 */

import pg from "pg";

const KAITO_API_KEY = process.env.KAITO_API_KEY!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const DATABASE_URL = process.env.DATABASE_URL!;
const DRY_RUN = process.argv.includes("--dry-run");
const USER_FILTER = process.argv.find((a) => a.startsWith("--user="))?.slice(7);
const DAYS_BACK = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7)) || 30;

if (!KAITO_API_KEY || !DATABASE_URL || !OPENROUTER_API_KEY) {
	console.error("Missing KAITO_API_KEY, OPENROUTER_API_KEY, or DATABASE_URL");
	process.exit(1);
}

const db = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const TWITTER_USER_API = "https://api.twitterapi.io/twitter/user/last_tweets";
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const ARTICLES_TABLE = "articles";

// -- Twitter Types ------------------------------------------------------------

interface Tweet {
	id?: string;
	url: string;
	text: string;
	createdAt: string;
	viewCount: number;
	author: { userName: string; name: string; profilePicture?: string };
	extendedEntities?: { media?: Array<{ media_url_https: string; type: string }> };
	hashTags?: string[];
	urls?: Array<{ expanded_url?: string; url?: string }>;
	isReply?: boolean;
	inReplyToUsername?: string | null;
	conversationId?: string;
	retweeted_tweet?: unknown;
	quoted_tweet?: {
		text?: string;
		author?: { userName?: string; name?: string; profilePicture?: string };
	} | null;
}

// -- Twitter Helpers ----------------------------------------------------------

function isNotRetweet(tweet: Tweet): boolean {
	return !tweet.retweeted_tweet && !tweet.text.startsWith("RT @");
}

function stripUrls(text: string): string {
	return text.replace(/https?:\/\/\S+/g, "").trim();
}

function extractMedia(tweet: Tweet) {
	return tweet.extendedEntities?.media?.filter((m) => m.media_url_https).map((m) => ({ url: m.media_url_https, type: m.type })) ?? [];
}

function buildQuotedTweet(tweet: Tweet) {
	const q = tweet.quoted_tweet;
	if (!q?.text || !q?.author) return undefined;
	return { authorName: q.author.name || "", authorUserName: q.author.userName || "", authorProfilePicture: q.author.profilePicture, text: stripUrls(q.text) };
}

// -- OpenRouter AI ------------------------------------------------------------

async function callOpenRouter(prompt: string, opts: { maxTokens?: number; temperature?: number; systemPrompt?: string } = {}): Promise<string | null> {
	const messages = opts.systemPrompt
		? [{ role: "system", content: opts.systemPrompt }, { role: "user", content: prompt }]
		: [{ role: "user", content: prompt }];

	const res = await fetch(OPENROUTER_API, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}`, "HTTP-Referer": "https://www.newsence.app" },
		body: JSON.stringify({ model: "google/gemini-3-flash-preview", messages, max_tokens: opts.maxTokens, temperature: opts.temperature ?? 0.3 }),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	return data.choices?.[0]?.message?.content ?? null;
}

function extractJson<T>(text: string): T | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try { return JSON.parse(match[0]) as T; } catch { return null; }
}

async function translateAndAnalyze(text: string): Promise<{ summary_cn: string; tags: string[]; keywords: string[]; title_cn: string }> {
	const prompt = `請分析以下推文並提供：
1. 繁體中文直接翻譯（保持原文語氣，不要第三人稱描述）
2. 標籤和關鍵字
3. 繁體中文標題（15字內摘要）

推文：
${text.substring(0, 2000)}

回傳 JSON：
{ "summary_cn": "繁體中文翻譯", "title_cn": "中文標題", "tags": ["tag1","tag2"], "keywords": ["kw1","kw2"] }
不要 Markdown 格式，純文字。只回傳 JSON。`;

	const raw = await callOpenRouter(prompt, { maxTokens: 500 });
	if (!raw) return { summary_cn: "", tags: ["Twitter"], keywords: [], title_cn: "" };

	const result = extractJson<{ summary_cn?: string; title_cn?: string; tags?: string[]; keywords?: string[] }>(raw);
	return {
		summary_cn: result?.summary_cn ?? "",
		title_cn: result?.title_cn ?? "",
		tags: (result?.tags ?? ["Twitter"]).slice(0, 5),
		keywords: (result?.keywords ?? []).slice(0, 8),
	};
}

async function translateContent(content: string): Promise<string | null> {
	return callOpenRouter(
		`請將以下內容翻譯成繁體中文。保持原文格式，直接翻譯，不要改寫。不要使用 Markdown 格式。\n\n${content.substring(0, 8000)}`,
		{ maxTokens: 2000 },
	);
}

// -- Fetch & Save -------------------------------------------------------------

async function fetchUserTweets(userName: string, sinceTime: number): Promise<Tweet[]> {
	const allTweets: Tweet[] = [];
	let cursor: string | null = null;
	let pages = 0;

	while (true) {
		const params = new URLSearchParams({ userName, sinceTime: sinceTime.toString(), includeReplies: "true", limit: "20" });
		if (cursor) params.append("cursor", cursor);

		const res = await fetch(`${TWITTER_USER_API}?${params}`, {
			headers: { "X-API-Key": KAITO_API_KEY, "Content-Type": "application/json" },
		});
		if (!res.ok) { console.error(`  API error ${res.status}`); break; }

		const apiRes = (await res.json()) as { status: string; data?: { tweets?: Tweet[] }; has_next_page?: boolean; next_cursor?: string };
		if (apiRes.status !== "success") { console.error(`  API: ${apiRes.status}`); break; }

		for (const tweet of apiRes.data?.tweets || []) {
			if (isNotRetweet(tweet)) allTweets.push(tweet);
		}

		pages++;
		if (!apiRes.has_next_page || pages > 50) break;
		cursor = apiRes.next_cursor || null;
	}

	return allTweets;
}

async function saveAndProcess(url: string, title: string, source: string, publishedDate: Date, text: string, media: any[], metadata: any): Promise<boolean> {
	const existing = await db.query(`SELECT 1 FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [url]);
	if (existing.rows.length > 0) return false;
	if (text.length < 150) return false;

	// Insert first
	const result = await db.query(
		`INSERT INTO ${ARTICLES_TABLE} (url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
		[url, title, source, publishedDate, new Date(), [], [], [], text, "twitter", text, media[0]?.url ?? null, JSON.stringify(metadata)],
	);
	const articleId = result.rows[0]?.id;
	if (!articleId) return false;

	// AI: translate + analyze
	const analysis = await translateAndAnalyze(text);
	const contentCn = text.length > 100 ? await translateContent(text) : null;

	// Update with AI results
	await db.query(
		`UPDATE ${ARTICLES_TABLE} SET summary_cn = $1, title_cn = $2, tags = $3, keywords = $4, content_cn = $5 WHERE id = $6`,
		[analysis.summary_cn, analysis.title_cn, analysis.tags, analysis.keywords, contentCn, articleId],
	);

	return true;
}

async function processTweet(tweet: Tweet): Promise<boolean> {
	const url = tweet.url.replace(/\?.*$/, "");
	const text = stripUrls(tweet.text);
	const media = extractMedia(tweet);
	const quotedTweet = buildQuotedTweet(tweet);
	const metadata = {
		type: "twitter", fetchedAt: new Date().toISOString(),
		data: { authorName: tweet.author.name, authorUserName: tweet.author.userName, authorProfilePicture: tweet.author.profilePicture, media, createdAt: tweet.createdAt, ...(quotedTweet && { quotedTweet }) },
	};
	const title = `@${tweet.author.userName}: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? "..." : ""}`;
	return saveAndProcess(url, title, tweet.author.name, new Date(tweet.createdAt), text, media, metadata);
}

async function processThread(tweets: Tweet[]): Promise<boolean> {
	const sorted = tweets.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	const first = sorted[0];
	const url = first.url.replace(/\?.*$/, "");
	const seen = new Set<string>();
	const uniqueTexts: string[] = [];
	for (const t of sorted.slice(0, 10)) {
		const text = stripUrls(t.text);
		if (text && !seen.has(text)) { seen.add(text); uniqueTexts.push(text); }
	}
	const combinedText = uniqueTexts.join("\n\n");
	const allMedia = sorted.flatMap(extractMedia);
	const quotedTweet = sorted.map(buildQuotedTweet).find(Boolean);
	const metadata = {
		type: "twitter", fetchedAt: new Date().toISOString(),
		data: { authorName: first.author.name, authorUserName: first.author.userName, authorProfilePicture: first.author.profilePicture, media: allMedia, createdAt: first.createdAt, ...(quotedTweet && { quotedTweet }) },
	};
	const title = `@${first.author.userName}: ${first.text.substring(0, 100)}${first.text.length > 100 ? "..." : ""}`;
	return saveAndProcess(url, title, first.author.name, new Date(first.createdAt), combinedText, allMedia, metadata);
}

// -- Main ---------------------------------------------------------------------

async function main() {
	await db.connect();
	console.log(DRY_RUN ? "=== DRY RUN ===" : "=== LIVE RUN (with AI translation) ===");
	console.log(`Looking back ${DAYS_BACK} days\n`);

	const result = await db.query(`SELECT name, "RSSLink" FROM "RssList" WHERE type = 'twitter_user' ORDER BY name`);
	let users = result.rows as Array<{ name: string; RSSLink: string }>;
	if (USER_FILTER) users = users.filter((u) => u.RSSLink === USER_FILTER);

	const latestResult = await db.query(`SELECT source, MAX(published_date) AS latest FROM ${ARTICLES_TABLE} WHERE source_type = 'twitter' GROUP BY source`);
	const latestMap = new Map(latestResult.rows.map((r: any) => [r.source, new Date(r.latest)]));
	const fallbackSince = Math.floor((Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000) / 1000);

	let totalSaved = 0;

	for (const user of users) {
		const latestDate = latestMap.get(user.name);
		const sinceTime = latestDate ? Math.floor((latestDate.getTime() - 60 * 60 * 1000) / 1000) : fallbackSince;
		console.log(`@${user.RSSLink} (${user.name}) — since ${new Date(sinceTime * 1000).toISOString().split("T")[0]}`);

		const tweets = await fetchUserTweets(user.RSSLink, sinceTime);
		console.log(`  Fetched ${tweets.length} original tweets`);

		// Separate root tweets from replies, detect threads
		const rootTweets = tweets.filter((t) => !t.isReply);
		const selfReplies = tweets.filter((t) => t.isReply && t.inReplyToUsername === t.author?.userName);
		const rootConvIds = new Set(rootTweets.map((t) => t.conversationId || t.id));
		const threadReplies = selfReplies.filter((t) => t.conversationId && rootConvIds.has(t.conversationId));

		const groups = new Map<string, Tweet[]>();
		for (const tweet of [...rootTweets, ...threadReplies]) {
			const key = tweet.conversationId || tweet.id || tweet.url;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(tweet);
		}

		let saved = 0;
		for (const groupTweets of groups.values()) {
			try {
				if (DRY_RUN) { saved++; continue; }
				const ok = groupTweets.length >= 2 ? await processThread(groupTweets) : await processTweet(groupTweets[0]);
				if (ok) {
					saved++;
					process.stdout.write(`  ${saved} saved\r`);
				}
			} catch (err) {
				console.error(`  Error: ${err}`);
			}
		}
		console.log(`  Saved ${saved} new articles\n`);
		totalSaved += saved;
	}

	console.log(`Done. Total saved: ${totalSaved}`);
	await db.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
