/**
 * Translate existing twitter articles that are missing Chinese translations.
 *
 * Usage:
 *   OPENROUTER_API_KEY=xxx DATABASE_URL=xxx npx tsx scripts/translate-tweets.ts [--dry-run]
 */

import pg from "pg";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const DATABASE_URL = process.env.DATABASE_URL!;
const DRY_RUN = process.argv.includes("--dry-run");

if (!OPENROUTER_API_KEY || !DATABASE_URL) {
	console.error("Missing OPENROUTER_API_KEY or DATABASE_URL");
	process.exit(1);
}

const db = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

async function callOpenRouter(prompt: string, maxTokens = 500): Promise<string | null> {
	const res = await fetch(OPENROUTER_API, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENROUTER_API_KEY}`, "HTTP-Referer": "https://www.newsence.app" },
		body: JSON.stringify({ model: "google/gemini-3-flash-preview", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.3 }),
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

async function main() {
	await db.connect();
	console.log(DRY_RUN ? "=== DRY RUN ===" : "=== LIVE RUN ===");

	const result = await db.query(`
		SELECT id, summary, content, source
		FROM articles
		WHERE source_type = 'twitter' AND summary_cn IS NULL
		ORDER BY published_date DESC
	`);

	const articles = result.rows as Array<{ id: string; summary: string; content: string | null; source: string }>;
	console.log(`${articles.length} articles need translation\n`);

	let done = 0;
	for (const article of articles) {
		const text = article.content || article.summary || "";
		if (!text || text.length < 10) continue;

		if (DRY_RUN) { done++; continue; }

		// Translate + analyze
		const analysisRaw = await callOpenRouter(`請分析以下推文：
1. 繁體中文直接翻譯（保持原文語氣，不要第三人稱描述）
2. 繁體中文標題（15字內摘要）
3. 標籤和關鍵字

推文：
${text.substring(0, 2000)}

回傳 JSON：
{ "summary_cn": "繁體中文翻譯", "title_cn": "中文標題", "tags": ["tag1","tag2"], "keywords": ["kw1","kw2"] }
不要 Markdown 格式。只回傳 JSON。`);

		const analysis = analysisRaw ? extractJson<{ summary_cn?: string; title_cn?: string; tags?: string[]; keywords?: string[] }>(analysisRaw) : null;

		// Translate content
		const contentCn = text.length > 100
			? await callOpenRouter(`請將以下內容翻譯成繁體中文。保持原文格式，直接翻譯。不要 Markdown。\n\n${text.substring(0, 8000)}`, 2000)
			: null;

		await db.query(
			`UPDATE articles SET summary_cn = $1, title_cn = $2, tags = $3, keywords = $4, content_cn = $5 WHERE id = $6`,
			[
				analysis?.summary_cn || null,
				analysis?.title_cn || null,
				analysis?.tags || [],
				analysis?.keywords || [],
				contentCn,
				article.id,
			],
		);

		done++;
		process.stdout.write(`\r  ${done}/${articles.length} translated`);
	}

	console.log(`\n\nDone. Translated ${done} articles.`);
	await db.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
