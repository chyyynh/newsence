/**
 * Smoke test: 真實呼叫 Algolia + OpenRouter，印出 generateHnEditorial 的 Markdown 輸出。
 *
 * 用法:
 *   npx tsx scripts/test-hn-editorial.ts [HN_ITEM_ID]
 *
 * 預設用一篇熱門 HN 討論串測試。你也可以帶自己的 item ID:
 *   npx tsx scripts/test-hn-editorial.ts 42415091
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 讀 API key from wrangler.jsonc ──────────────────────────

function loadApiKey(): string {
	const raw = readFileSync(resolve(__dirname, '../wrangler.jsonc'), 'utf-8');
	const match = raw.match(/"OPENROUTER_API_KEY"\s*:\s*"([^"]+)"/);
	if (!match?.[1]) throw new Error('找不到 OPENROUTER_API_KEY，請確認 wrangler.jsonc');
	return match[1];
}

// ── 從 processors.ts 複製的最小邏輯 ────────────────────────

interface HnComment { id?: number; author?: string; text?: string; children?: HnComment[] }
interface HnCollectedComment { id?: number; author?: string; text: string }

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
	const comments: HnCollectedComment[] = [];
	for (const child of children) {
		if (child.text) {
			const clean = cleanHtmlText(child.text);
			if (clean) comments.push({ id: child.id, author: child.author, text: clean });
		}
		if (child.children?.length) comments.push(...collectAllComments(child.children));
	}
	return comments;
}

// ── OpenRouter 呼叫 ─────────────────────────────────────────

async function callOpenRouter(
	apiKey: string, systemPrompt: string, userPrompt: string, maxTokens: number
): Promise<string | null> {
	const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
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
	if (!res.ok) { console.error('OpenRouter error:', res.status, await res.text()); return null; }
	const data = await res.json() as any;
	return data.choices?.[0]?.message?.content ?? null;
}

// ── 主流程（和 generateHnEditorial 完全一致的 prompt）──────

async function main() {
	const itemId = process.argv[2] || '42415091'; // 預設：一篇有討論的 HN post
	const apiKey = loadApiKey();

	console.log(`\n🔍 Fetching HN item ${itemId} ...\n`);
	const hnRes = await fetch(`https://hn.algolia.com/api/v1/items/${itemId}`);
	if (!hnRes.ok) { console.error('Algolia error:', hnRes.status); process.exit(1); }
	const hn = await hnRes.json() as any;

	const comments = collectAllComments(hn.children ?? []);

	console.log(`Title: ${hn.title}`);
	console.log(`Comments collected: ${comments.length}`);
	console.log(`External URL: ${hn.url || '(none)'}`);

	// 抓主文連結（和 processors.ts extractPostLinks 一樣）
	const seen = new Set<string>();
	const links: string[] = [];
	if (hn.url) { seen.add(hn.url); links.push(hn.url); }
	if (hn.text) {
		const hrefMatches = (hn.text as string).match(/href="([^"]+)"/g);
		for (const m of hrefMatches ?? []) {
			const raw = m.slice(6, -1).replace(/&#x2F;/g, '/').replace(/&amp;/g, '&');
			if (!seen.has(raw) && raw.startsWith('http')) { seen.add(raw); links.push(raw); }
		}
	}
	console.log(`\nPost links (${links.length}):`);
	links.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
	console.log('');

	if (comments.length < 4) {
		console.log('留言數 < 4，generateHnEditorial 會跳過。選一篇討論多的試試。');
		process.exit(0);
	}

	// 組 prompt（和 processors.ts generateHnEditorial 一致）
	const commentInput = comments
		.map((c) => `${c.author ? `${c.author}: ` : ''}${c.text}`)
		.join('\n')
		.slice(0, 30000);
	const pageExcerpt = ''; // script 不抓外部文章，只測 HN 討論整理
	const hnTextClean = cleanHtmlText(hn.text || '').slice(0, 1200) || 'N/A';

	// ── CN prompt ──
	const cnSystem = '你是一位專業的科技新聞編輯，負責將 Hacker News 討論串整理成深度筆記。只使用提供的素材，直接輸出繁體中文 Markdown。';
	const cnUser = `Title: ${hn.title}
Article excerpt (${pageExcerpt.length} chars):
${pageExcerpt || 'N/A'}

HN post text:
${hnTextClean}

HN comments (${comments.length} total):
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

	// ── EN prompt ──
	const enSystem = 'You are a professional tech news editor. Summarize Hacker News discussions into in-depth editorial notes. Use only the provided material. Output Markdown directly.';
	const enUser = `Title: ${hn.title}
Article excerpt (${pageExcerpt.length} chars):
${pageExcerpt || 'N/A'}

HN post text:
${hnTextClean}

HN comments (${comments.length} total):
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

	console.log('Calling OpenRouter (gemini-3-flash-preview) for CN + EN in parallel ...\n');

	const [cnResult, enResult] = await Promise.all([
		callOpenRouter(apiKey, cnSystem, cnUser, 1200),
		callOpenRouter(apiKey, enSystem, enUser, 1000),
	]);

	console.log('═'.repeat(60));
	console.log('CN OUTPUT:');
	console.log('═'.repeat(60));
	console.log(cnResult ?? '(null — AI 沒有回傳)');
	console.log(`\nCN length: ${cnResult?.length ?? 0} chars`);

	console.log('\n' + '═'.repeat(60));
	console.log('EN OUTPUT:');
	console.log('═'.repeat(60));
	console.log(enResult ?? '(null — no response)');
	console.log(`\nEN length: ${enResult?.length ?? 0} chars`);
}

main().catch(e => { console.error(e); process.exit(1); });
