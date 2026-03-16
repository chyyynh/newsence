/**
 * Backfill script: merge threads and add quoted tweet content.
 *
 * Usage:
 *   KAITO_API_KEY=xxx DATABASE_URL=xxx npx tsx scripts/backfill-threads.ts [--dry-run]
 *
 * What it does:
 * 1. Fetches all twitter article status IDs from DB
 * 2. Re-fetches tweet data from Kaito API to get conversationId + quoted_tweet
 * 3. Merges thread tweets into single articles
 * 4. Appends quoted tweet text to quote tweets that are missing it
 */

import pg from "pg";

const KAITO_API_KEY = process.env.KAITO_API_KEY!;
const DATABASE_URL = process.env.DATABASE_URL!;
const DRY_RUN = process.argv.includes("--dry-run");

if (!KAITO_API_KEY || !DATABASE_URL) {
	console.error("Missing KAITO_API_KEY or DATABASE_URL");
	process.exit(1);
}

const db = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

interface ArticleRow {
	id: string;
	url: string;
	source: string;
	summary: string | null;
	content: string | null;
	published_date: Date;
	platform_metadata: any;
}

interface KaitoTweet {
	id: string;
	conversationId?: string;
	quoted_tweet?: {
		text?: string;
		author?: { userName?: string; name?: string; profilePicture?: string };
	} | null;
}

function extractStatusId(url: string): string | null {
	const match = url.match(/\/status\/(\d+)/);
	return match?.[1] ?? null;
}

async function fetchTweetsBatch(tweetIds: string[]): Promise<Map<string, KaitoTweet>> {
	const result = new Map<string, KaitoTweet>();
	const batchSize = 10;

	for (let i = 0; i < tweetIds.length; i += batchSize) {
		const batch = tweetIds.slice(i, i + batchSize);
		const res = await fetch(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${batch.join(",")}`, {
			headers: { "X-API-Key": KAITO_API_KEY, "Content-Type": "application/json" },
		});

		if (!res.ok) {
			console.error(`  API error ${res.status} for batch ${i}`);
			continue;
		}

		const data = (await res.json()) as { tweets?: KaitoTweet[] };
		for (const tweet of data.tweets || []) {
			result.set(tweet.id, tweet);
		}

		if (i + batchSize < tweetIds.length) {
			await new Promise((r) => setTimeout(r, 1000));
		}
		process.stdout.write(`\r  Fetched ${Math.min(i + batchSize, tweetIds.length)}/${tweetIds.length}`);
	}
	console.log();

	return result;
}

async function mergeThreads(articles: ArticleRow[], tweetMap: Map<string, KaitoTweet>): Promise<{ merged: number; deleted: number }> {
	// Group articles by conversationId
	const threadGroups = new Map<string, ArticleRow[]>();

	for (const article of articles) {
		const statusId = extractStatusId(article.url);
		if (!statusId) continue;
		const tweet = tweetMap.get(statusId);
		const convId = tweet?.conversationId;
		if (!convId) continue;

		const key = `${article.source}::${convId}`;
		if (!threadGroups.has(key)) threadGroups.set(key, []);
		threadGroups.get(key)!.push(article);
	}

	const threads = [...threadGroups.entries()].filter(([, tweets]) => tweets.length >= 2);
	console.log(`  Found ${threads.length} threads to merge`);

	let merged = 0;
	let deleted = 0;

	for (const [key, tweets] of threads) {
		const sorted = tweets.sort((a, b) => new Date(a.published_date).getTime() - new Date(b.published_date).getTime());
		const first = sorted[0];
		const rest = sorted.slice(1);

		console.log(`  [Thread ${key}] ${sorted.length} tweets`);
		for (const t of sorted) {
			console.log(`    ${t.id} | ${(t.summary || "").substring(0, 50)}`);
		}

		if (DRY_RUN) continue;

		const combinedText = sorted
			.map((t) => (t.content || t.summary || "").replace(/https?:\/\/\S+/g, "").trim())
			.filter(Boolean)
			.join("\n\n");

		const allMedia: any[] = [];
		for (const t of sorted) {
			const media = t.platform_metadata?.data?.media;
			if (Array.isArray(media)) allMedia.push(...media);
		}

		const updatedMetadata = {
			...first.platform_metadata,
			data: { ...first.platform_metadata?.data, media: allMedia },
		};

		await db.query(`UPDATE articles SET summary = $1, content = $2, platform_metadata = $3 WHERE id = $4`, [
			combinedText,
			combinedText,
			JSON.stringify(updatedMetadata),
			first.id,
		]);

		const restIds = rest.map((t) => t.id);
		await db.query(`DELETE FROM articles WHERE id = ANY($1)`, [restIds]);

		merged++;
		deleted += restIds.length;
		console.log(`    → Merged into ${first.id}, deleted ${restIds.length}`);
	}

	return { merged, deleted };
}

async function backfillQuotes(articles: ArticleRow[], tweetMap: Map<string, KaitoTweet>): Promise<number> {
	let updated = 0;

	for (const article of articles) {
		const statusId = extractStatusId(article.url);
		if (!statusId) continue;

		const tweet = tweetMap.get(statusId);
		const q = tweet?.quoted_tweet;
		if (!q?.text || !q?.author?.userName) continue;

		// Skip if metadata already has quotedTweet
		if (article.platform_metadata?.data?.quotedTweet) continue;

		const quotedTweet = {
			authorName: q.author.name || q.author.userName || "",
			authorUserName: q.author.userName,
			authorProfilePicture: q.author.profilePicture,
			text: q.text.replace(/https?:\/\/\S+/g, "").trim(),
		};

		console.log(`  [Quote] ${article.id} | @${article.source} quotes @${q.author.userName}`);
		console.log(`    ${q.text.substring(0, 60)}`);

		if (DRY_RUN) {
			updated++;
			continue;
		}

		// Add quotedTweet to metadata
		const updatedMetadata = {
			...article.platform_metadata,
			data: { ...article.platform_metadata?.data, quotedTweet },
		};

		// Remove blockquote from content/summary if it was previously added
		const blockquotePattern = new RegExp(`\\n\\n> @${q.author.userName}:.*`, "s");
		const cleanContent = (article.content || "").replace(blockquotePattern, "").trim();
		const cleanSummary = (article.summary || "").replace(blockquotePattern, "").trim();

		await db.query(`UPDATE articles SET summary = $1, content = $2, platform_metadata = $3 WHERE id = $4`, [
			cleanSummary,
			cleanContent,
			JSON.stringify(updatedMetadata),
			article.id,
		]);
		updated++;
	}

	return updated;
}

async function main() {
	await db.connect();
	console.log(DRY_RUN ? "=== DRY RUN ===" : "=== LIVE RUN ===");

	// Fetch all twitter articles
	const result = await db.query<ArticleRow>(`
		SELECT id, url, source, summary, content, published_date, platform_metadata
		FROM articles WHERE source_type = 'twitter'
		ORDER BY source, published_date
	`);

	const articles = result.rows;
	console.log(`\nLoaded ${articles.length} twitter articles from DB`);

	// Fetch tweet data from Kaito
	const statusIds = articles.map((a) => extractStatusId(a.url)).filter(Boolean) as string[];
	console.log(`\nFetching ${statusIds.length} tweets from Kaito API...`);
	const tweetMap = await fetchTweetsBatch(statusIds);
	console.log(`Got data for ${tweetMap.size} tweets`);

	// Phase 1: Merge threads
	console.log("\n--- Phase 1: Thread Merging ---");
	const { merged, deleted } = await mergeThreads(articles, tweetMap);
	console.log(`Threads: ${merged} merged, ${deleted} deleted`);

	// Phase 2: Backfill quote tweets
	console.log("\n--- Phase 2: Quote Tweet Backfill ---");
	const quoted = await backfillQuotes(articles, tweetMap);
	console.log(`Quotes: ${quoted} updated`);

	console.log("\nDone.");
	await db.end();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
