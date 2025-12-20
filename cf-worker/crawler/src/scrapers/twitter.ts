import type { ScrapedContent } from '../types';

interface KaitoTweet {
	id: string;
	url: string;
	text: string;
	createdAt: string;
	viewCount?: number;
	likeCount?: number;
	retweetCount?: number;
	replyCount?: number;
	quoteCount?: number;
	lang?: string;
	author?: {
		userName: string;
		name: string;
		isBlueVerified?: boolean;
		profilePicture?: string;
	};
	extendedEntities?: {
		media?: Array<{ media_url_https: string; type: string }>;
	};
	entities?: {
		hashtags?: Array<{ text: string }>;
	};
}

/**
 * Scrapes a single tweet using Kaito API
 */
export async function scrapeTweet(tweetId: string, apiKey: string): Promise<ScrapedContent> {
	console.log(`[TWITTER-SCRAPER] Fetching tweet ${tweetId}...`);

	// Use tweets endpoint to get tweet by ID
	const response = await fetch(`https://api.twitterapi.io/twitter/tweets?tweet_ids=${tweetId}`, {
		method: 'GET',
		headers: {
			'X-API-Key': apiKey,
			'Content-Type': 'application/json',
		},
	});

	if (!response.ok) {
		throw new Error(`Kaito API error: HTTP ${response.status}`);
	}

	const data = (await response.json()) as { tweets?: KaitoTweet[]; status: string; msg?: string };

	if (data.status !== 'success' || !data.tweets || data.tweets.length === 0) {
		throw new Error(`Kaito API error: ${data.msg || 'Tweet not found'}`);
	}

	const tweet = data.tweets[0];

	// Extract first media image from extendedEntities
	const media = tweet.extendedEntities?.media;
	const ogImageUrl = media && media.length > 0 ? media[0].media_url_https : null;

	// Extract hashtags
	const hashtags = tweet.entities?.hashtags?.map((h) => h.text) || [];

	const content = formatTweetAsMarkdown(tweet, hashtags, media);
	const title = `@${tweet.author?.userName}: ${tweet.text.substring(0, 80)}${tweet.text.length > 80 ? '...' : ''}`;

	console.log(`[TWITTER-SCRAPER] Fetched tweet from @${tweet.author?.userName}`);

	// Extract all media URLs
	const mediaUrls = media?.map((m) => m.media_url_https) || [];

	return {
		title,
		content,
		summary: tweet.text,
		ogImageUrl: tweet.author?.profilePicture || null, // Use profile picture as og image for Twitter
		siteName: 'Twitter',
		author: tweet.author?.userName || null,
		publishedDate: tweet.createdAt,
		metadata: {
			tweetId: tweet.id,
			tweetUrl: tweet.url,
			authorName: tweet.author?.name,
			authorUserName: tweet.author?.userName,
			authorProfilePicture: tweet.author?.profilePicture,
			authorVerified: tweet.author?.isBlueVerified,
			viewCount: tweet.viewCount || 0,
			likeCount: tweet.likeCount || 0,
			retweetCount: tweet.retweetCount || 0,
			replyCount: tweet.replyCount || 0,
			quoteCount: tweet.quoteCount || 0,
			hashtags,
			lang: tweet.lang,
			mediaUrls,
		},
	};
}

/**
 * Formats a tweet as Markdown content
 */
function formatTweetAsMarkdown(
	tweet: KaitoTweet,
	hashtags: string[],
	media?: Array<{ media_url_https: string; type: string }>
): string {
	let md = `# Tweet by @${tweet.author?.userName}\n\n`;

	// Tweet text as blockquote
	md += `> ${tweet.text.replace(/\n/g, '\n> ')}\n\n`;

	// Author info
	md += `**Author:** ${tweet.author?.name || 'Unknown'}`;
	if (tweet.author?.isBlueVerified) {
		md += ' (Verified)';
	}
	md += `\n**Handle:** @${tweet.author?.userName}\n`;

	// Posted time
	if (tweet.createdAt) {
		md += `**Posted:** ${new Date(tweet.createdAt).toLocaleString()}\n`;
	}

	md += '\n---\n\n';

	// Engagement metrics
	md += '**Engagement:**\n';
	md += `- Views: ${(tweet.viewCount || 0).toLocaleString()}\n`;
	md += `- Likes: ${(tweet.likeCount || 0).toLocaleString()}\n`;
	md += `- Retweets: ${(tweet.retweetCount || 0).toLocaleString()}\n`;
	md += `- Replies: ${(tweet.replyCount || 0).toLocaleString()}\n`;
	md += `- Quotes: ${(tweet.quoteCount || 0).toLocaleString()}\n`;

	// Hashtags
	if (hashtags.length > 0) {
		md += `\n**Hashtags:** ${hashtags.map((h) => `#${h}`).join(' ')}\n`;
	}

	// Media
	if (media && media.length > 0) {
		md += '\n**Media:**\n';
		media.forEach((m, idx) => {
			md += `![Media ${idx + 1}](${m.media_url_https})\n`;
		});
	}

	return md;
}
