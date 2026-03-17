import { XMLParser } from "fast-xml-parser";
import type { Client } from "pg";
import { type FeedConfig, getFeedConfig } from "../domain/feed-config";
import {
	type RSSItem,
	extractItemsFromFeed,
	extractRssFullContent,
	extractUrlFromItem,
	htmlToMarkdown,
	stripHtml,
	toPlainText,
} from "../domain/rss";
import {
	detectPlatformType,
	extractHackerNewsId,
	HN_ALGOLIA_API,
	scrapeTwitterArticle,
	scrapeWebPage,
} from "../domain/scrapers";
import { ARTICLES_TABLE, createDbClient } from "../infra/db";
import { logError, logInfo, logWarn } from "../infra/log";
import { isSocialMediaUrl, normalizeUrl, resolveUrl } from "../infra/web";
import type {
	PlatformMetadata,
	QuotedTweetData,
	TwitterMedia,
} from "../models/platform-metadata";
import {
	buildHackerNews,
	buildTwitterArticle,
	buildTwitterShared,
	buildTwitterStandard,
} from "../models/platform-metadata";
import type { Env, ExecutionContext, RSSFeed, Tweet } from "../models/types";

// ─────────────────────────────────────────────────────────────
// RSS Monitor
// ─────────────────────────────────────────────────────────────

async function fetchHnPlatformMetadata(
	commentsUrl: string,
): Promise<(PlatformMetadata & { type: "hackernews" }) | null> {
	if (detectPlatformType(commentsUrl) !== "hackernews") return null;
	const hnItemId = extractHackerNewsId(commentsUrl);
	if (!hnItemId) return null;
	const res = await fetch(`${HN_ALGOLIA_API}/${hnItemId}`);
	if (!res.ok) return null;
	const hn = (await res.json()) as {
		id: number;
		author?: string;
		points?: number;
		descendants?: number;
		type?: string;
	};
	return buildHackerNews({
		itemId: hn.id.toString(),
		author: hn.author ?? "",
		points: hn.points ?? 0,
		commentCount: hn.descendants ?? 0,
		itemType: (hn.type as "story" | "ask" | "show" | "job") ?? "story",
		storyUrl: commentsUrl,
	});
}

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function processAndInsertArticle(
	db: Client,
	env: Env,
	item: RSSItem,
	feed: RSSFeed,
	config: FeedConfig,
): Promise<void> {
	const rawUrl = extractUrlFromItem(item);
	const url = rawUrl ? normalizeUrl(rawUrl) : null;
	if (!url) return;

	let platformMetadata: PlatformMetadata | null = null;
	let sourceType = "rss";
	let crawledContent = "";
	let ogImageUrl: string | null = null;
	let ogImageWidth: number | null = null;
	let ogImageHeight: number | null = null;
	// Determine source type from the RSS item's comments URL
	const commentsUrl = item.comments as string | undefined;
	if (commentsUrl) {
		try {
			const hnMeta = await fetchHnPlatformMetadata(commentsUrl);
			if (hnMeta) {
				sourceType = "hackernews";
				platformMetadata = hnMeta;
			}
		} catch (err) {
			logWarn("RSS", "Failed to fetch HN metadata", {
				feed: feed.name,
				error: String(err),
			});
		}
	}

	// Fetch content based on feed config
	if (sourceType === "rss") {
		switch (config.contentSource) {
			case "content_encoded": {
				const rssContent = extractRssFullContent(item);
				if (rssContent) crawledContent = rssContent;
				break;
			}
			case "description": {
				const raw = toPlainText(item.description);
				if (raw && raw.length > 100) crawledContent = htmlToMarkdown(raw);
				break;
			}
			case "scrape": {
				const rssContent = extractRssFullContent(item);
				if (rssContent) {
					crawledContent = rssContent;
				} else {
					try {
						const scraped = await scrapeWebPage(url);
						crawledContent = scraped.content;
						if (!ogImageUrl) {
							ogImageUrl = scraped.ogImageUrl;
							ogImageWidth = scraped.ogImageWidth ?? null;
							ogImageHeight = scraped.ogImageHeight ?? null;
						}
					} catch {}
				}
				break;
			}
			case "skip":
				break;
		}
	}

	const pubDate =
		item.pubDate ?? item.isoDate ?? item.published ?? item.updated;
	const content = crawledContent || null;

	const table = ARTICLES_TABLE;
	const publishedDate = pubDate ? new Date(pubDate) : new Date();
	const scrapedDate = new Date();
	const title = item.title ?? item.text ?? "No Title";
	const source = feed.name ?? "Unknown";
	const summary =
		sourceType === "hackernews" || config.summarySource === "ai"
			? ""
			: stripHtml(item.description ?? item.summary ?? "");

	const result = await db.query(
		`INSERT INTO ${table} (url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 RETURNING id`,
		[
			url,
			title,
			source,
			publishedDate,
			scrapedDate,
			[],
			[],
			[],
			summary,
			sourceType,
			content,
			ogImageUrl,
			platformMetadata
				? JSON.stringify({ ...platformMetadata, ogImageWidth, ogImageHeight })
				: ogImageWidth && ogImageHeight
					? JSON.stringify({
							type: "default",
							fetchedAt: new Date().toISOString(),
							data: null,
							ogImageWidth,
							ogImageHeight,
						})
					: null,
		],
	);

	if (result.rows.length === 0)
		return logError("RSS", "Insert error", {
			feed: feed.name,
			error: "No rows returned",
		});

	const articleId = result.rows[0]?.id;
	if (articleId) {
		await env.ARTICLE_QUEUE.send({
			type: "article_process",
			article_id: articleId,
			source_type: sourceType,
		});
	}
}

async function processFeed(
	db: Client,
	env: Env,
	feed: RSSFeed,
	parser: XMLParser,
): Promise<void> {
	if (feed.type !== "rss") return;

	const res = await fetch(feed.RSSLink, {
		headers: {
			"User-Agent": USER_AGENT,
			Accept: "application/rss+xml, application/xml, text/xml, */*",
		},
	});
	if (!res.ok)
		return logWarn("RSS", "Feed fetch failed", {
			feed: feed.name,
			status: res.status,
		});

	let items = extractItemsFromFeed(parser.parse(await res.text()));
	if (!items.length) return;

	const config = getFeedConfig(feed.name);

	if (items.length > 30) items = items.slice(0, 30);

	// Filter existing URLs
	const urls = items
		.map((item) => extractUrlFromItem(item))
		.filter(Boolean)
		.map((u) => normalizeUrl(u!));
	const table = ARTICLES_TABLE;
	const dedupBatchSize = 50;
	const existingRecords: Array<{ url: string; source: string; source_type: string }> = [];

	for (let i = 0; i < urls.length; i += dedupBatchSize) {
		const batch = urls.slice(i, i + dedupBatchSize);
		const result = await db.query(
			`SELECT url, source, source_type FROM ${table} WHERE url = ANY($1)`,
			[batch],
		);
		existingRecords.push(
			...(result.rows as Array<{ url: string; source: string; source_type: string }>),
		);
	}

	const existingSet = new Set(existingRecords.map((e) => normalizeUrl(e.url)));
	const newItems = items.filter((item) => {
		const url = extractUrlFromItem(item);
		return url && !existingSet.has(normalizeUrl(url));
	});

	// Upgrade source to this feed when a duplicate exists from a lower-priority source
	// e.g., a tweet already saved by Twitter cron gets upgraded to "Hacker News" when HN links to it
	const SOURCE_PRIORITY: Record<string, number> = {
		Unknown: 0,
		Telegram: 1,
	};
	const TYPE_PRIORITY: Record<string, number> = { twitter: 0 };
	const feedPriority = SOURCE_PRIORITY[feed.name] ?? 10; // RSS feeds default to high priority

	// Build URL→item map for fetching comments URL during upgrade
	const urlToItem = new Map<string, RSSItem>();
	for (const item of items) {
		const url = extractUrlFromItem(item);
		if (url) urlToItem.set(normalizeUrl(url), item);
	}

	for (const existing of existingRecords) {
		const existingPriority = SOURCE_PRIORITY[existing.source] ?? TYPE_PRIORITY[existing.source_type] ?? 10;
		if (feedPriority > existingPriority) {
			const normalized = normalizeUrl(existing.url);
			const updateFields: string[] = ["source = $1"];
			const updateValues: unknown[] = [feed.name];
			let paramIndex = 2;

			// Fetch platform metadata from the RSS item's comments URL (e.g., HN discussion)
			const rssItem = urlToItem.get(normalized);
			const commentsUrl = rssItem?.comments as string | undefined;
			if (commentsUrl) {
				try {
					const hnMeta = await fetchHnPlatformMetadata(commentsUrl);
					if (hnMeta) {
						updateFields.push(`source_type = $${paramIndex}`);
						updateValues.push("hackernews");
						paramIndex++;
						updateFields.push(`platform_metadata = $${paramIndex}`);
						updateValues.push(JSON.stringify(hnMeta));
						paramIndex++;
					}
				} catch (err) {
					logWarn("RSS", "Failed to fetch HN metadata for upgrade", {
						url: normalized,
						error: String(err),
					});
				}
			}

			updateValues.push(normalized);
			await db.query(
				`UPDATE ${table} SET ${updateFields.join(", ")} WHERE url = $${paramIndex}`,
				updateValues,
			);
			logInfo("RSS", "Upgraded article source", {
				url: normalized,
				from: existing.source,
				to: feed.name,
			});
		}
	}

	logInfo("RSS", "Feed processed", {
		feed: feed.name,
		newCount: newItems.length,
		totalCount: items.length,
	});
	let inserted = 0;
	for (const item of newItems) {
		try {
			await processAndInsertArticle(db, env, item, feed, config);
			inserted++;
		} catch (err) {
			logWarn("RSS", "Item insert failed, skipping", {
				feed: feed.name,
				url: extractUrlFromItem(item),
				error: String(err),
			});
		}
	}
	logInfo("RSS", "Feed insert done", {
		feed: feed.name,
		inserted,
		total: newItems.length,
	});
	await db.query(`UPDATE "RssList" SET scraped_at = $1 WHERE id = $2`, [
		new Date(),
		feed.id,
	]);
}

export async function handleRSSCron(
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	logInfo("RSS", "start");
	const db = await createDbClient(env);
	try {
		const parser = new XMLParser({ ignoreAttributes: false });
		const result = await db.query(
			`SELECT id, name, "RSSLink", url, type FROM "RssList"`,
		);
		const feeds = result.rows as RSSFeed[];
		const FEED_CONCURRENCY = 5;
		for (let i = 0; i < feeds.length; i += FEED_CONCURRENCY) {
			const batch = feeds.slice(i, i + FEED_CONCURRENCY);
			const results = await Promise.allSettled(
				batch.map((feed: RSSFeed) => processFeed(db, env, feed, parser)),
			);
			for (let j = 0; j < results.length; j++) {
				if (results[j].status === "rejected") {
					logWarn("RSS", "Feed failed", {
						feed: batch[j].name,
						error: String((results[j] as PromiseRejectedResult).reason),
					});
				}
			}
		}
		logInfo("RSS", "end");
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Twitter Monitor
// ─────────────────────────────────────────────────────────────

const TWITTER_ADVANCED_SEARCH_API = "https://api.twitterapi.io/twitter/tweet/advanced_search";

/** Skip RTs. All other filtering (replies vs threads) handled in Phase 2. */
function isNotRetweet(tweet: Tweet): boolean {
	return !tweet.retweeted_tweet && !tweet.text.startsWith("RT @");
}

/** Extract quoted tweet data for platform_metadata */
function extractQuotedTweet(tweet: Tweet): QuotedTweetData | undefined {
	const q = tweet.quoted_tweet;
	if (!q?.text || !q?.author) return undefined;
	return {
		authorName: q.author.name || "",
		authorUserName: q.author.userName || "",
		authorProfilePicture: q.author.profilePicture,
		text: q.text.replace(/https?:\/\/\S+/g, "").trim(),
	};
}

// -- Twitter Helpers ----------------------------------------------------------

function extractTweetMedia(tweet: Tweet): TwitterMedia[] {
	return (
		tweet.extendedEntities?.media?.flatMap((m) =>
			m.media_url_https ? [{ url: m.media_url_https, type: m.type as TwitterMedia["type"] }] : [],
		) ?? []
	);
}

function extractAuthor(tweet: Tweet) {
	return {
		authorName: tweet.author?.name || "",
		authorUserName: tweet.author?.userName || "",
		authorProfilePicture: tweet.author?.profilePicture,
	};
}

async function urlExists(db: Client, url: string): Promise<boolean> {
	const result = await db.query(`SELECT 1 FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [url]);
	return result.rows.length > 0;
}

async function urlsExist(db: Client, urls: string[]): Promise<boolean> {
	const normalized = urls.map(normalizeUrl).filter(Boolean);
	if (normalized.length === 0) return false;
	const result = await db.query(`SELECT 1 FROM ${ARTICLES_TABLE} WHERE url = ANY($1) LIMIT 1`, [normalized]);
	return result.rows.length > 0;
}

/** Insert a twitter article and queue it for AI processing */
async function insertTwitterArticle(
	db: Client,
	env: Env,
	data: {
		url: string;
		title: string;
		source: string;
		publishedDate: Date;
		summary: string;
		content: string | null;
		ogImage: string | null;
		metadata: PlatformMetadata;
		hashTags?: string[];
	},
): Promise<string | null> {
	const result = await db.query(
		`INSERT INTO ${ARTICLES_TABLE} (url, title, source, published_date, scraped_date, keywords, tags, tokens, summary, source_type, content, og_image_url, platform_metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 RETURNING id`,
		[
			data.url, data.title, data.source, data.publishedDate, new Date(),
			data.hashTags || [], [], [], data.summary, "twitter",
			data.content, data.ogImage, JSON.stringify(data.metadata),
		],
	);
	const articleId = result.rows[0]?.id;
	if (articleId) {
		await env.ARTICLE_QUEUE.send({ type: "article_process", article_id: articleId, source_type: "twitter" });
	}
	return articleId || null;
}

// -- Twitter Article (long-form) ----------------------------------------------

async function handleTwitterArticle(tweet: Tweet, db: Client, env: Env): Promise<boolean> {
	const expandedUrls = (tweet.urls || []).map((u) => u.expanded_url || u.url || "").filter(Boolean);
	const articleUrl = expandedUrls.find((u) => /(?:twitter\.com|x\.com)\/i\/article\//.test(u));
	if (!articleUrl) return false;

	const tweetId = tweet.id || tweet.url.split("/").pop();
	if (!tweetId) return false;

	logInfo("TWITTER", "Detected Twitter Article", { tweetId, articleUrl });
	const scraped = await scrapeTwitterArticle(tweetId, env.KAITO_API_KEY || "");
	if (!scraped) {
		logWarn("TWITTER", "Article API failed, falling through");
		return false;
	}

	const meta = scraped.metadata as Record<string, any> | undefined;
	const id = await insertTwitterArticle(db, env, {
		url: normalizeUrl(tweet.url),
		title: scraped.title,
		source: tweet.author?.name || "Twitter",
		publishedDate: scraped.publishedDate ? new Date(scraped.publishedDate) : new Date(),
		summary: scraped.summary || "",
		content: scraped.content,
		ogImage: scraped.ogImageUrl || null,
		metadata: buildTwitterArticle({
			authorName: meta?.authorName || tweet.author?.name || "",
			authorUserName: meta?.authorUserName || tweet.author?.userName || "",
			authorProfilePicture: meta?.authorProfilePicture || tweet.author?.profilePicture,
		}),
	});

	if (id) logInfo("TWITTER", "Saved Twitter Article", { title: scraped.title.slice(0, 50) });
	return !!id;
}

// -- Triage (rule-based, no AI) -----------------------------------------------

/** Rule-based content triage. Tracked users are curated, so no AI needed for quality gating. */
const MIN_TWEET_LENGTH = 150;

function triageTweet(textWithoutUrls: string, links: string[]): "save" | "follow_link" | "discard" {
	if (textWithoutUrls.length < MIN_TWEET_LENGTH) return links.length > 0 ? "follow_link" : "discard";
	return "save";
}

// -- Follow Link (tweet shares an external URL) -------------------------------

async function handleFollowLink(tweet: Tweet, textWithoutUrls: string, links: string[], db: Client, env: Env): Promise<boolean> {
	const resolvedUrl = await resolveUrl(links[0]!);

	if (isSocialMediaUrl(resolvedUrl)) {
		logInfo("TWITTER", "Skipped social media link", { url: resolvedUrl });
		return false;
	}
	if (await urlsExist(db, [resolvedUrl])) {
		logInfo("TWITTER", "Link already exists (dedup)", { url: resolvedUrl });
		return false;
	}

	let scraped;
	try {
		scraped = await scrapeWebPage(resolvedUrl);
	} catch (err) {
		logWarn("TWITTER", "Failed to scrape followed link", { url: resolvedUrl, error: String(err) });
		return false;
	}

	// Skip if scraped content is too short to be meaningful
	if (!scraped.content || scraped.content.length < 100) {
		logInfo("TWITTER", "Scraped content too short", { url: resolvedUrl, chars: scraped.content?.length ?? 0 });
		return false;
	}

	const id = await insertTwitterArticle(db, env, {
		url: resolvedUrl,
		title: scraped.title || "Shared Article",
		source: tweet.author?.name || "Twitter",
		publishedDate: tweet.createdAt ? new Date(tweet.createdAt) : new Date(),
		summary: "",
		content: scraped.content,
		ogImage: scraped.ogImageUrl,
		metadata: buildTwitterShared(extractAuthor(tweet), {
			media: extractTweetMedia(tweet),
			createdAt: tweet.createdAt,
			tweetText: textWithoutUrls,
			externalUrl: resolvedUrl,
			externalOgImage: scraped.ogImageUrl,
			externalTitle: scraped.title || null,
		}),
	});

	if (id) logInfo("TWITTER", "Saved shared article", { title: scraped.title?.slice(0, 50) });
	return !!id;
}

// -- Save Single Tweet --------------------------------------------------------

async function saveTweet(tweet: Tweet, db: Client, env: Env): Promise<boolean> {
	const tweetUrl = normalizeUrl(tweet.url);
	if (await urlExists(db, tweetUrl)) return false;

	// 1. Twitter Article?
	if (await handleTwitterArticle(tweet, db, env)) return true;

	const links = tweet.text.match(/https?:\/\/\S+/g) || [];
	const textWithoutUrls = tweet.text.replace(/https?:\/\/\S+/g, "").trim();

	// 2. Rule-based triage (no AI — tracked users are curated)
	const triage = triageTweet(textWithoutUrls, links);

	if (triage === "discard") {
		logInfo("TWITTER", "Filtered tweet", { author: tweet.author?.userName, reason: "too short, no links" });
		return false;
	}

	if (triage === "follow_link") {
		return handleFollowLink(tweet, textWithoutUrls, links, db, env);
	}

	// 3. Save as tweet
	const expandedUrls = (tweet.urls || []).map((u) => u.expanded_url || u.url || "").filter(Boolean);
	const externalUrl = expandedUrls.find((u) => !/(?:twitter\.com|x\.com|t\.co)/.test(u));

	if (externalUrl && (await urlsExist(db, [externalUrl]))) {
		logInfo("TWITTER", "External URL already exists (dedup)", { url: externalUrl });
		return false;
	}

	// Fetch external link metadata if present
	let externalOgImage: string | null = null;
	let externalTitle: string | null = null;
	let externalContent: string | null = null;
	if (externalUrl) {
		try {
			const scraped = await scrapeWebPage(externalUrl);
			externalOgImage = scraped.ogImageUrl;
			externalTitle = scraped.title || null;
			if (scraped.content && scraped.content.length > 100) externalContent = scraped.content;
		} catch {
			logWarn("TWITTER", "Failed to fetch external link metadata", { url: externalUrl });
		}
	}

	const author = extractAuthor(tweet);
	const media = extractTweetMedia(tweet);
	const metadata = externalUrl
		? buildTwitterShared(author, { media, createdAt: tweet.createdAt, tweetText: textWithoutUrls, externalUrl, externalOgImage, externalTitle })
		: buildTwitterStandard(author, { media, createdAt: tweet.createdAt, quotedTweet: extractQuotedTweet(tweet) });

	const id = await insertTwitterArticle(db, env, {
		url: tweetUrl,
		title: `@${tweet.author?.userName}: ${tweet.text.substring(0, 100)}${tweet.text.length > 100 ? "..." : ""}`,
		source: tweet.author?.name || "Twitter",
		publishedDate: new Date(tweet.createdAt),
		summary: textWithoutUrls,
		content: externalContent || textWithoutUrls || null,
		ogImage: media[0]?.url ?? externalOgImage ?? null,
		metadata,
		hashTags: tweet.hashTags,
	});

	if (id) logInfo("TWITTER", "Saved tweet", { author: tweet.author?.userName });
	return !!id;
}

// -- Save Thread (multiple tweets merged) -------------------------------------

async function saveThread(tweets: Tweet[], db: Client, env: Env): Promise<boolean> {
	const sorted = tweets.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
	const first = sorted[0];
	const firstUrl = normalizeUrl(first.url);

	// If root tweet already exists, update it with merged content
	const existing = await db.query(`SELECT id, content FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [firstUrl]);

	// Dedup repeated text (e.g. same reply to multiple people) and cap at 10 tweets
	const seen = new Set<string>();
	const uniqueTexts: string[] = [];
	for (const t of sorted.slice(0, 10)) {
		const text = t.text.replace(/https?:\/\/\S+/g, "").trim();
		if (text && !seen.has(text)) {
			seen.add(text);
			uniqueTexts.push(text);
		}
	}
	const combinedText = uniqueTexts.join("\n\n");
	const allMedia = sorted.flatMap(extractTweetMedia);
	const quotedTweet = sorted.map(extractQuotedTweet).find(Boolean);
	const author = extractAuthor(first);
	const metadata = buildTwitterStandard(author, { media: allMedia, createdAt: first.createdAt, quotedTweet });

	if (existing.rows.length > 0) {
		// Update existing root tweet with merged thread content and re-queue for AI processing
		const existingId = existing.rows[0].id;
		await db.query(
			`UPDATE ${ARTICLES_TABLE} SET summary = $1, content = $2, platform_metadata = $3, summary_cn = NULL, content_cn = NULL, title_cn = NULL, embedding = NULL WHERE id = $4`,
			[combinedText, combinedText, JSON.stringify(metadata), existingId],
		);
		await env.ARTICLE_QUEUE.send({ type: "article_process", article_id: existingId, source_type: "twitter" });
		logInfo("TWITTER", "Updated thread", { author: first.author?.userName, tweets: sorted.length });
		return true;
	}

	const id = await insertTwitterArticle(db, env, {
		url: firstUrl,
		title: `@${first.author?.userName}: ${first.text.substring(0, 100)}${first.text.length > 100 ? "..." : ""}`,
		source: first.author?.name || "Twitter",
		publishedDate: new Date(first.createdAt),
		summary: combinedText,
		content: combinedText,
		ogImage: allMedia[0]?.url ?? null,
		metadata,
		hashTags: first.hashTags,
	});

	if (id) logInfo("TWITTER", "Saved thread", { author: first.author?.userName, tweets: sorted.length });
	return !!id;
}

/** Max usernames per query batch to stay within query length limits */
const TWITTER_BATCH_SIZE = 20;

/** Format a unix timestamp (seconds) to Twitter advanced search date format */
function toTwitterDate(epochSec: number): string {
	return new Date(epochSec * 1000).toISOString().replace("T", "_").replace(/\.\d+Z$/, "_UTC");
}

/**
 * Fetch tweets for a batch of users via Advanced Search API.
 * Builds a query like: (from:user1 OR from:user2 ...) since:2025-01-01_00:00:00_UTC
 */
async function fetchBatchTweets(
	apiKey: string,
	userNames: string[],
	sinceTime: number,
	db: Client,
	env: Env,
): Promise<{ count: number; completed: boolean }> {
	const fromClause = userNames.map((u) => `from:${u}`).join(" OR ");
	const sinceDate = toTwitterDate(sinceTime);
	const query = `(${fromClause}) since:${sinceDate}`;

	const allTweets: Tweet[] = [];
	let cursor = "";
	let completed = true;

	// Phase 1: Paginate through all results
	while (true) {
		const params = new URLSearchParams({
			query,
			queryType: "Latest",
		});
		if (cursor) params.set("cursor", cursor);

		const res = await fetch(`${TWITTER_ADVANCED_SEARCH_API}?${params}`, {
			headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
		});
		if (!res.ok) {
			logError("TWITTER", "Advanced Search HTTP error", { status: res.status, statusText: res.statusText });
			completed = false;
			break;
		}

		const apiRes = (await res.json()) as {
			tweets?: Tweet[];
			has_next_page?: boolean;
			next_cursor?: string;
		};

		const tweets = apiRes.tweets || [];
		for (const tweet of tweets) {
			if (isNotRetweet(tweet)) allTweets.push(tweet);
		}

		if (!apiRes.has_next_page) break;
		cursor = apiRes.next_cursor || "";
		if (!cursor) break;
		await new Promise((r) => setTimeout(r, 1000));
	}

	// Phase 2: Thread detection — group by author then by conversationId
	const rootTweets = allTweets.filter((t) => !t.isReply);
	const selfReplies = allTweets.filter((t) => t.isReply && t.inReplyToUsername === t.author?.userName);

	const rootConversationIds = new Set(rootTweets.map((t) => t.conversationId || t.id));
	const threadReplies = selfReplies.filter((t) => t.conversationId && rootConversationIds.has(t.conversationId));
	const orphanReplies = selfReplies.filter((t) => !t.conversationId || !rootConversationIds.has(t.conversationId));

	const groups = new Map<string, Tweet[]>();
	for (const tweet of [...rootTweets, ...threadReplies, ...orphanReplies]) {
		const key = tweet.conversationId || tweet.id || tweet.url;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(tweet);
	}

	// Phase 3: Save each group
	let count = 0;
	for (const tweets of groups.values()) {
		try {
			if (tweets.length >= 2) {
				if (await saveThread(tweets, db, env)) count++;
			} else {
				if (await saveTweet(tweets[0], db, env)) count++;
			}
		} catch (err) {
			logError("TWITTER", "Save failed", { url: tweets[0]?.url, error: String(err) });
		}
	}

	return { count, completed };
}

export async function handleTwitterCron(
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	logInfo("TWITTER", "start");
	const db = await createDbClient(env);
	try {
		const result = await db.query(
			`SELECT id, name, "RSSLink", url, type, scraped_at FROM "RssList" WHERE type = $1`,
			["twitter_user"],
		);
		const users = result.rows as RSSFeed[];

		if (!users.length) {
			logInfo("TWITTER", "No twitter_user entries in RssList");
			return;
		}

		// Compute the global sinceTime from the oldest scraped_at across all users
		// (with 1-hour overlap for safety)
		const oldestScrapedAt = users.reduce((min, u) => {
			if (!u.scraped_at) return min;
			const t = new Date(u.scraped_at).getTime();
			return t < min ? t : min;
		}, Date.now());
		const sinceTime = Math.floor(
			(oldestScrapedAt - 60 * 60 * 1000) / 1000,
		);
		// Fallback: if no user has been scraped before, look back 24h
		const effectiveSince = users.some((u) => u.scraped_at)
			? sinceTime
			: Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

		// Batch users into groups of TWITTER_BATCH_SIZE
		const userNames = users.map((u) => u.RSSLink).filter(Boolean);
		const batches: string[][] = [];
		for (let i = 0; i < userNames.length; i += TWITTER_BATCH_SIZE) {
			batches.push(userNames.slice(i, i + TWITTER_BATCH_SIZE));
		}

		logInfo("TWITTER", "Fetching via Advanced Search", {
			users: userNames.length,
			batches: batches.length,
			sinceTime: effectiveSince,
		});

		let total = 0;
		let allCompleted = true;
		for (const batch of batches) {
			const batchResult = await fetchBatchTweets(
				env.KAITO_API_KEY || "",
				batch,
				effectiveSince,
				db,
				env,
			);
			total += batchResult.count;
			if (!batchResult.completed) allCompleted = false;
		}

		// Advance scraped_at only for users that were actually fetched
		if (allCompleted) {
			const now = new Date();
			const ids = users.map((u) => u.id);
			await db.query(
				`UPDATE "RssList" SET scraped_at = $1 WHERE id = ANY($2)`,
				[now, ids],
			);
		}

		logInfo("TWITTER", "end", { inserted: total, users: users.length, batches: batches.length });
	} finally {
		await db.end();
	}
}

// ─────────────────────────────────────────────────────────────
// Retry Failed Articles
// ─────────────────────────────────────────────────────────────

const RETRY_BATCH_SIZE = 20;

export async function handleRetryCron(
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	logInfo("RETRY", "start");
	const db = await createDbClient(env);
	try {
		const table = ARTICLES_TABLE;
		const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

		// AI processing failures
		const aiResult = await db.query(
			`SELECT id FROM ${table} WHERE scraped_date >= $1 AND (title_cn IS NULL OR summary_cn IS NULL OR embedding IS NULL)`,
			[since],
		);

		// Translation failures (content exists but content_cn is null)
		const translationResult = await db.query(
			`SELECT id FROM ${table} WHERE scraped_date >= $1 AND content IS NOT NULL AND content_cn IS NULL`,
			[since],
		);

		const ids = [
			...new Set([
				...(aiResult.rows as Array<{ id: string }>).map((r) => r.id),
				...(translationResult.rows as Array<{ id: string }>).map((r) => r.id),
			]),
		];

		if (!ids.length) return logInfo("RETRY", "No incomplete articles");
		for (let i = 0; i < ids.length; i += RETRY_BATCH_SIZE) {
			await env.ARTICLE_QUEUE.send({
				type: "batch_process",
				article_ids: ids.slice(i, i + RETRY_BATCH_SIZE),
				triggered_by: "retry_cron",
			});
		}
		logInfo("RETRY", "Queued articles for retry", {
			count: ids.length,
			batches: Math.ceil(ids.length / RETRY_BATCH_SIZE),
		});
	} finally {
		await db.end();
	}
}
