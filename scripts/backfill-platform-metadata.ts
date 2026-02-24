/**
 * Backfill: Normalize platform_metadata to canonical shapes
 *
 * Usage:
 *   npx tsx scripts/backfill-platform-metadata.ts              # Dry-run (default)
 *   npx tsx scripts/backfill-platform-metadata.ts --write       # Actually write to DB
 *   npx tsx scripts/backfill-platform-metadata.ts --limit 10    # Process max N articles
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────

interface Config {
	supabaseUrl: string;
	supabaseKey: string;
	articlesTable: string;
}

function loadConfig(): Config {
	const raw = readFileSync(resolve(__dirname, '../wrangler.jsonc'), 'utf-8');
	const get = (key: string): string => {
		const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
		if (!m?.[1]) throw new Error(`Missing ${key} in wrangler.jsonc`);
		return m[1];
	};
	return {
		supabaseUrl: get('SUPABASE_URL'),
		supabaseKey: get('SUPABASE_SERVICE_ROLE_KEY'),
		articlesTable: get('ARTICLES_TABLE'),
	};
}

// ── Types ────────────────────────────────────────────────────

interface RawMetadata {
	type?: string;
	fetchedAt?: string;
	data?: Record<string, any>;
	enrichments?: Record<string, any>;
}

interface Stats {
	total: number;
	skipped: number;
	twitter: number;
	youtube: number;
	hackernews: number;
	other: number;
	errors: number;
}

// ── Twitter normalization ────────────────────────────────────

function normalizeTwitterData(data: Record<string, any>): Record<string, any> {
	const normalized: Record<string, any> = {};

	// Author fields
	normalized.authorName = data.authorName ?? '';
	normalized.authorUserName = data.authorUserName ?? '';
	if (data.authorProfilePicture) normalized.authorProfilePicture = data.authorProfilePicture;
	if (data.authorVerified != null) normalized.authorVerified = data.authorVerified;

	// tweetId
	if (data.tweetId) normalized.tweetId = data.tweetId;

	// Normalize media: mediaUrls → media[] if media is absent
	if (data.media && Array.isArray(data.media) && data.media.length > 0) {
		normalized.media = data.media.map((m: any) => ({
			url: m.url || m.media_url_https,
			type: m.type || 'photo',
		}));
	} else if (data.mediaUrls && Array.isArray(data.mediaUrls) && data.mediaUrls.length > 0) {
		normalized.media = data.mediaUrls.map((url: string) => ({ url, type: 'photo' }));
	} else if (data.variant !== 'article') {
		normalized.media = [];
	}

	// createdAt
	if (data.createdAt) normalized.createdAt = data.createdAt;

	// Determine variant
	if (data.variant === 'article') {
		normalized.variant = 'article';
	} else if (data.variant === 'shared' || data.externalUrl || data.linkedUrl) {
		normalized.variant = 'shared';
		normalized.externalUrl = data.externalUrl || data.linkedUrl || '';
		if (data.externalOgImage !== undefined) normalized.externalOgImage = data.externalOgImage;
		if (data.externalTitle !== undefined) normalized.externalTitle = data.externalTitle;
		if (data.tweetText) normalized.tweetText = data.tweetText;
		if (data.originalTweetUrl) normalized.originalTweetUrl = data.originalTweetUrl;
	}

	// Dropped fields: mediaUrls, linkedUrl, sharedBy, tweetUrl, hashtags, expandedUrls, lang

	return normalized;
}

// ── YouTube normalization ────────────────────────────────────

function normalizeYouTubeData(data: Record<string, any>, articleUrl?: string): Record<string, any> {
	const normalized: Record<string, any> = {};

	// videoId - required, extract from URL if missing
	normalized.videoId = data.videoId || extractYouTubeId(articleUrl || '') || '';
	normalized.channelName = data.channelName || '';

	if (data.channelId) normalized.channelId = data.channelId;
	if (data.channelAvatar) normalized.channelAvatar = data.channelAvatar;
	if (data.duration) normalized.duration = data.duration;
	if (data.thumbnailUrl) normalized.thumbnailUrl = data.thumbnailUrl;
	if (data.viewCount != null) normalized.viewCount = data.viewCount;
	if (data.likeCount != null) normalized.likeCount = data.likeCount;
	if (data.commentCount != null) normalized.commentCount = data.commentCount;
	if (data.publishedAt) normalized.publishedAt = data.publishedAt;
	if (data.description) normalized.description = data.description;
	if (data.tags && Array.isArray(data.tags)) normalized.tags = data.tags;

	// Strip transcript fields (should be in youtube_transcripts table)
	// Dropped: transcript, chapters, transcriptLanguage, chaptersFromDescription

	return normalized;
}

function extractYouTubeId(url: string): string | null {
	const patterns = [
		/[?&]v=([a-zA-Z0-9_-]{11})/,
		/youtu\.be\/([a-zA-Z0-9_-]{11})/,
		/\/embed\/([a-zA-Z0-9_-]{11})/,
		/\/shorts\/([a-zA-Z0-9_-]{11})/,
	];
	for (const p of patterns) {
		const m = url.match(p);
		if (m) return m[1];
	}
	return null;
}

// ── HN normalization ─────────────────────────────────────────

function normalizeHackerNewsData(data: Record<string, any>, enrichments?: Record<string, any>): Record<string, any> {
	return {
		itemId: data.itemId || '',
		author: data.author || '',
		points: data.points || 0,
		commentCount: data.commentCount || 0,
		...(data.itemType && { itemType: data.itemType }),
		storyUrl: data.storyUrl ?? enrichments?.externalUrl ?? null,
	};
}

// ── Canonical check ──────────────────────────────────────────

function isAlreadyCanonical(meta: RawMetadata): boolean {
	if (!meta.type || !meta.data) return false;

	const data = meta.data;

	switch (meta.type) {
		case 'twitter_shared':
		case 'twitter_article':
			return false; // Legacy type — always needs migration
		case 'twitter':
			// Not canonical if it has legacy fields
			if ('mediaUrls' in data || 'linkedUrl' in data || 'sharedBy' in data || 'tweetUrl' in data || 'hashtags' in data || 'expandedUrls' in data || 'lang' in data) {
				return false;
			}
			// Must have media array (unless article variant)
			if (data.variant !== 'article' && !Array.isArray(data.media)) return false;
			return true;

		case 'youtube':
			// videoId must be present and string
			if (!data.videoId || typeof data.videoId !== 'string') return false;
			// No transcript fields
			if ('transcript' in data || 'chapters' in data || 'transcriptLanguage' in data) return false;
			return true;

		case 'hackernews':
			// Must have storyUrl field (even if null)
			if (!('storyUrl' in data)) return false;
			return true;

		default:
			return true;
	}
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);
	const dryRun = !args.includes('--write');
	const limitArg = args.indexOf('--limit');
	const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;

	const config = loadConfig();
	const supabase = createClient(config.supabaseUrl, config.supabaseKey);
	const table = config.articlesTable;

	console.log(`\n🔧 Platform Metadata Backfill`);
	console.log(`   Mode: ${dryRun ? 'DRY RUN' : '⚠️  WRITE MODE'}`);
	console.log(`   Table: ${table}`);
	console.log(`   Limit: ${limit === Infinity ? 'none' : limit}\n`);

	const stats: Stats = { total: 0, skipped: 0, twitter: 0, youtube: 0, hackernews: 0, other: 0, errors: 0 };
	const BATCH_SIZE = 100;
	let offset = 0;
	let processed = 0;

	while (processed < limit) {
		const { data: articles, error } = await supabase
			.from(table)
			.select('id, url, platform_metadata')
			.not('platform_metadata', 'is', null)
			.range(offset, offset + BATCH_SIZE - 1)
			.order('scraped_date', { ascending: false });

		if (error) {
			console.error(`❌ Query error at offset ${offset}:`, error.message);
			break;
		}

		if (!articles || articles.length === 0) break;

		for (const article of articles) {
			if (processed >= limit) break;
			stats.total++;

			const meta = article.platform_metadata as RawMetadata;
			if (!meta?.type || !meta.data) {
				stats.skipped++;
				continue;
			}

			if (isAlreadyCanonical(meta)) {
				stats.skipped++;
				continue;
			}

			try {
				let normalizedData: Record<string, any>;
				let canonicalType = meta.type!;

				switch (meta.type) {
					case 'twitter':
					case 'twitter_shared':
					case 'twitter_article':
						normalizedData = normalizeTwitterData(meta.data);
						canonicalType = 'twitter';
						stats.twitter++;
						break;
					case 'youtube':
						normalizedData = normalizeYouTubeData(meta.data, article.url);
						stats.youtube++;
						break;
					case 'hackernews':
						normalizedData = normalizeHackerNewsData(meta.data, meta.enrichments);
						stats.hackernews++;
						break;
					default:
						stats.other++;
						continue;
				}

				const updated: RawMetadata = {
					type: canonicalType,
					fetchedAt: meta.fetchedAt || new Date().toISOString(),
					data: normalizedData,
					...(meta.enrichments && { enrichments: meta.enrichments }),
				};

				if (dryRun) {
					console.log(`  [${meta.type}] ${article.id} — would update`);
					const before = Object.keys(meta.data);
					const after = Object.keys(normalizedData);
					const dropped = before.filter((k) => !after.includes(k));
					const added = after.filter((k) => !before.includes(k));
					if (dropped.length) console.log(`    dropped: ${dropped.join(', ')}`);
					if (added.length) console.log(`    added: ${added.join(', ')}`);
				} else {
					const { error: updateError } = await supabase
						.from(table)
						.update({ platform_metadata: updated })
						.eq('id', article.id);

					if (updateError) {
						console.error(`  ❌ [${meta.type}] ${article.id} — ${updateError.message}`);
						stats.errors++;
					}
				}

				processed++;
			} catch (err) {
				console.error(`  ❌ [${meta.type}] ${article.id} — ${err}`);
				stats.errors++;
			}
		}

		offset += BATCH_SIZE;
	}

	console.log(`\n📊 Results:`);
	console.log(`   Total scanned: ${stats.total}`);
	console.log(`   Skipped (already canonical): ${stats.skipped}`);
	console.log(`   Twitter normalized: ${stats.twitter}`);
	console.log(`   YouTube normalized: ${stats.youtube}`);
	console.log(`   HackerNews normalized: ${stats.hackernews}`);
	console.log(`   Other: ${stats.other}`);
	console.log(`   Errors: ${stats.errors}`);
	if (dryRun) console.log(`\n   ℹ️  Dry run — no changes written. Use --write to apply.\n`);
	else console.log(`\n   ✅ Done.\n`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
