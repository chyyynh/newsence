/**
 * Backfill: 重新產生所有 HN 文章的 content (EN) + content_cn (editorial)
 *
 * 用法:
 *   npx tsx scripts/backfill-hn-editorial.ts              # 只處理缺 content_cn 的
 *   npx tsx scripts/backfill-hn-editorial.ts --all         # 全部重新產生（覆蓋既有）
 *   npx tsx scripts/backfill-hn-editorial.ts --dry-run     # 只列出，不寫入
 *   npx tsx scripts/backfill-hn-editorial.ts --limit 5     # 最多處理 N 篇
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────

interface Config {
	openrouterKey: string;
	supabaseUrl: string;
	supabaseKey: string;
	articlesTable: string;
}

function loadConfig(): Config {
	const raw = readFileSync(resolve(__dirname, '../wrangler.jsonc'), 'utf-8');
	const get = (key: string): string => {
		const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
		if (!m?.[1]) throw new Error(`找不到 ${key}，請確認 wrangler.jsonc`);
		return m[1];
	};
	return {
		openrouterKey: get('OPENROUTER_API_KEY'),
		supabaseUrl: get('SUPABASE_URL'),
		supabaseKey: get('SUPABASE_SERVICE_ROLE_KEY'),
		articlesTable: get('ARTICLES_TABLE'),
	};
}

// ── CLI flags ────────────────────────────────────────────────

function parseFlags() {
	const args = process.argv.slice(2);
	const getNum = (flag: string, fallback: number) => {
		const idx = args.indexOf(flag);
		return idx >= 0 ? parseInt(args[idx + 1] || String(fallback), 10) : fallback;
	};
	return {
		all: args.includes('--all'),
		dryRun: args.includes('--dry-run'),
		limit: getNum('--limit', 999),
		offset: getNum('--offset', 0),
	};
}

// ── HN helpers (mirrors processors.ts) ──────────────────────

interface HnComment {
	id?: number;
	author?: string;
	text?: string;
	children?: HnComment[];
}
interface HnCollectedComment {
	id?: number;
	author?: string;
	text: string;
}

function cleanHtmlText(raw: string): string {
	return raw
		.replace(/<[^>]*>/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;|&#39;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ')
		.trim();
}

function collectAllComments(children: HnComment[]): HnCollectedComment[] {
	const out: HnCollectedComment[] = [];
	for (const c of children) {
		if (c.text) {
			const clean = cleanHtmlText(c.text);
			if (clean) out.push({ id: c.id, author: c.author, text: clean });
		}
		if (c.children?.length) out.push(...collectAllComments(c.children));
	}
	return out;
}

function extractPostLinks(externalUrl?: string | null, hnTextHtml?: string | null): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	if (externalUrl) {
		seen.add(externalUrl);
		urls.push(externalUrl);
	}
	if (hnTextHtml) {
		for (const m of hnTextHtml.match(/href="([^"]+)"/g) ?? []) {
			const raw = m
				.slice(6, -1)
				.replace(/&#x2F;/g, '/')
				.replace(/&amp;/g, '&');
			if (!seen.has(raw) && raw.startsWith('http')) {
				seen.add(raw);
				urls.push(raw);
			}
		}
	}
	return urls;
}

// ── OpenRouter ───────────────────────────────────────────────

async function callOpenRouter(apiKey: string, systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string | null> {
	const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
			'HTTP-Referer': 'https://app.newsence.xyz',
		},
		body: JSON.stringify({
			model: 'google/gemini-3-flash-preview',
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt },
			],
			max_tokens: maxTokens,
			temperature: 0.3,
		}),
	});
	if (!res.ok) {
		console.error('  OpenRouter error:', res.status, await res.text());
		return null;
	}
	const data = (await res.json()) as any;
	return data.choices?.[0]?.message?.content ?? null;
}

// ── Editorial prompts (mirrors processors.ts) ────────────────

function buildCnPrompt(title: string, hnText: string, commentInput: string, commentCount: number, pageExcerpt: string) {
	const system = '你是一位專業的科技新聞編輯，負責將 Hacker News 討論串整理成深度筆記。只使用提供的素材，直接輸出繁體中文 Markdown。';
	const user = `Title: ${title}
Article excerpt (${pageExcerpt.length} chars):
${pageExcerpt || 'N/A'}

HN post text:
${cleanHtmlText(hnText).slice(0, 1200) || 'N/A'}

HN comments (${commentCount} total):
${commentInput}

請用繁體中文撰寫 500-800 字的整理筆記，用段落式敘述，不要用條列式重點。格式：

## 背景
2-3 句介紹文章脈絡，讓沒看過原文的人快速了解在討論什麼。

## 社群觀點
最重要的部分。用連貫的段落整理 HN 留言者的觀點，包括主要的支持與反對意見、有趣的補充觀點、值得注意的爭論或共識。像寫一篇短評一樣自然地串接不同觀點。

## 延伸閱讀
留言中提到的有價值的資源、工具、連結。沒有就省略此段。

Rules:
- 繁體中文，嚴禁簡體
- 不要使用任何 emoji
- 重點是社群怎麼看，不是複述原文
- 引用留言觀點做歸納，不逐字翻譯
- 語氣中立客觀但不死板
- 直接輸出 Markdown，不要包在 code block 裡`;
	return { system, user };
}

function buildEnPrompt(title: string, hnText: string, commentInput: string, commentCount: number, pageExcerpt: string) {
	const system =
		'You are a professional tech news editor. Summarize Hacker News discussions into in-depth editorial notes. Use only the provided material. Output Markdown directly.';
	const user = `Title: ${title}
Article excerpt (${pageExcerpt.length} chars):
${pageExcerpt || 'N/A'}

HN post text:
${cleanHtmlText(hnText).slice(0, 1200) || 'N/A'}

HN comments (${commentCount} total):
${commentInput}

Write a 400-600 word editorial note in English using flowing paragraphs, not bullet points. Format:

## Background
2-3 sentences of context so a reader unfamiliar with the article can quickly understand what is being discussed.

## Community Perspectives
The most important section. Summarize HN commenters' viewpoints in coherent paragraphs — major arguments for and against, interesting supplementary perspectives, and notable debates or consensus. Weave different viewpoints together naturally, like a short commentary piece.

## Further Reading
Valuable resources, tools, or links mentioned in the comments. Omit this section if none.

Rules:
- Write in English
- Do not use any emoji
- Focus on how the community reacted, not restating the article
- Synthesize and paraphrase commenter opinions — do not translate verbatim
- Maintain a neutral, objective but engaging tone
- Output Markdown directly, do not wrap in a code block`;
	return { system, user };
}

// ── Supabase helpers ─────────────────────────────────────────

async function supabaseGet(cfg: Config, query: string): Promise<any[]> {
	const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${query}`, {
		headers: { apikey: cfg.supabaseKey, Authorization: `Bearer ${cfg.supabaseKey}` },
	});
	if (!res.ok) throw new Error(`Supabase GET error: ${res.status} ${await res.text()}`);
	return res.json() as any;
}

async function supabasePatch(cfg: Config, id: string, body: Record<string, unknown>): Promise<void> {
	const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${cfg.articlesTable}?id=eq.${id}`, {
		method: 'PATCH',
		headers: {
			apikey: cfg.supabaseKey,
			Authorization: `Bearer ${cfg.supabaseKey}`,
			'Content-Type': 'application/json',
			Prefer: 'return=minimal',
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Supabase PATCH error: ${res.status} ${await res.text()}`);
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
	const flags = parseFlags();
	const cfg = loadConfig();

	console.log(`\nBackfill HN editorials  (all=${flags.all}, dryRun=${flags.dryRun}, limit=${flags.limit}, offset=${flags.offset})\n`);

	// 1. 查詢 HN 文章
	const fields = 'id,title,content,platform_metadata';
	const base = flags.all
		? `${cfg.articlesTable}?source_type=eq.hackernews&select=${fields}&order=scraped_date.desc&limit=${flags.limit}`
		: `${cfg.articlesTable}?source_type=eq.hackernews&content_cn=is.null&select=${fields}&order=scraped_date.desc&limit=${flags.limit}`;
	const filter = flags.offset > 0 ? `${base}&offset=${flags.offset}` : base;
	const articles = await supabaseGet(cfg, filter);
	console.log(`Found ${articles.length} HN articles to process\n`);

	if (articles.length === 0) return;

	let success = 0;
	let skipped = 0;
	let failed = 0;

	for (let i = 0; i < articles.length; i++) {
		const article = articles[i];
		const itemId = article.platform_metadata?.data?.itemId;
		const tag = `[${i + 1}/${articles.length}]`;

		console.log(`${tag} ${article.title.slice(0, 70)}`);

		if (!itemId) {
			console.log(`  SKIP: no itemId in platform_metadata\n`);
			skipped++;
			continue;
		}

		// 2. Algolia
		const hnRes = await fetch(`https://hn.algolia.com/api/v1/items/${itemId}`);
		if (!hnRes.ok) {
			console.log(`  SKIP: Algolia ${hnRes.status}\n`);
			skipped++;
			continue;
		}
		const hn = (await hnRes.json()) as any;
		const comments = collectAllComments(hn.children ?? []);
		console.log(`  comments: ${comments.length}, externalUrl: ${hn.url || '(none)'}`);

		// 用 DB 裡已有的 content 當 page excerpt（之前 scrape 過的）
		const pageExcerpt = (article.content || '').slice(0, 6000);

		if (comments.length < 4 && pageExcerpt.length < 600) {
			console.log(`  SKIP: comments < 4 && no page content\n`);
			skipped++;
			continue;
		}

		if (flags.dryRun) {
			console.log(`  DRY-RUN: would generate editorial\n`);
			success++;
			continue;
		}

		// 3. Generate EN + CN
		const commentInput = comments
			.map((c) => `${c.author ? `${c.author}: ` : ''}${c.text}`)
			.join('\n')
			.slice(0, 30000);

		const cn = buildCnPrompt(article.title, hn.text || '', commentInput, comments.length, pageExcerpt);
		const en = buildEnPrompt(article.title, hn.text || '', commentInput, comments.length, pageExcerpt);

		const [cnResult, enResult] = await Promise.all([
			callOpenRouter(cfg.openrouterKey, cn.system, cn.user, 1200),
			callOpenRouter(cfg.openrouterKey, en.system, en.user, 1000),
		]);

		if (!cnResult && !enResult) {
			console.log(`  FAILED: both AI calls returned null\n`);
			failed++;
			continue;
		}

		// 4. Build update + enrichments
		const update: Record<string, unknown> = {};
		if (cnResult) update.content_cn = cnResult;
		if (enResult) update.content = enResult;

		const links = extractPostLinks(hn.url, hn.text);
		const enrichments = {
			...(article.platform_metadata?.enrichments || {}),
			hnUrl: `https://news.ycombinator.com/item?id=${hn.id}`,
			externalUrl: hn.url || null,
			hnText: hn.text || null,
			commentCount: comments.length,
			links,
			processedAt: new Date().toISOString(),
		};
		update.platform_metadata = { ...article.platform_metadata, enrichments };

		// 5. Write to Supabase
		await supabasePatch(cfg, article.id, update);

		console.log(`  OK: content=${enResult?.length ?? 0}c, content_cn=${cnResult?.length ?? 0}c\n`);
		success++;

		// rate limit: 避免打爆 OpenRouter
		if (i < articles.length - 1) await new Promise((r) => setTimeout(r, 1000));
	}

	console.log(`\nDone: ${success} success, ${skipped} skipped, ${failed} failed`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
