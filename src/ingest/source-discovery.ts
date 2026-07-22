import { fetchWithTimeout, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import type { SourceAcquisitionMode, SourcePlatform } from '@core-shared/resource-types';
import { parseFeed } from 'feedsmith';
import { decode } from 'html-entities';

// Resolves user input (site URL / feed URL / handle / channel URL) into the
// exact source row the crons can monitor. Owns the acquisition-layer facts —
// which feed URL a platform fetches — so the app worker never encodes them.

export type ResolveSourceCandidateInput = { platform: SourcePlatform; input: string };

export type ResolvedSourceCandidate = {
	platform: SourcePlatform;
	handle: string;
	name: string;
	siteUrl: string | null;
	avatarUrl: string | null;
	acquisitionMode: SourceAcquisitionMode;
};

const MAX_DISCOVERY_BYTES = 1024 * 1024;
const TWITTER_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE_RE = /^@?[A-Za-z0-9._-]{3,30}$/;

const DISCOVERY_HEADERS = {
	'User-Agent': WEB_FETCH_USER_AGENT,
	Accept: 'application/rss+xml, application/atom+xml, application/feed+json, text/html, application/xml, text/xml, */*',
};

function parseHttpUrl(value: string): URL | null {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password) return null;
	return url;
}

// Canonical handle form keeps UNIQUE(platform, handle) deduping equivalent inputs.
function canonicalFeedHandle(url: URL): string {
	url.hash = '';
	url.hostname = url.hostname.toLowerCase();
	if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
	return url.toString();
}

function textish(value: unknown): string | null {
	if (typeof value === 'string') {
		const text = decode(value).trim();
		return text || null;
	}
	if (typeof value === 'object' && value !== null && 'value' in value) {
		return textish((value as { value: unknown }).value);
	}
	return null;
}

function parsedFeedTitle(body: string): { title: string | null } | null {
	try {
		const { feed } = parseFeed(body);
		return { title: textish((feed as { title?: unknown }).title) };
	} catch {
		return null;
	}
}

async function fetchTextForDiscovery(url: string): Promise<string> {
	const response = await fetchWithTimeout(url, { headers: DISCOVERY_HEADERS });
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`Fetch failed with HTTP ${status}: ${url}`);
	}
	return readTextWithLimit(response, MAX_DISCOVERY_BYTES);
}

const HTML_LINK_TAG_RE = /<link\b[^>]*>/gi;

function discoverFeedHref(html: string, baseUrl: URL): string | null {
	for (const tag of html.match(HTML_LINK_TAG_RE) ?? []) {
		if (!/rel=["']?alternate["']?/i.test(tag)) continue;
		if (!/type=["']?application\/(?:rss|atom)\+xml["']?/i.test(tag)) continue;
		const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
		if (!href) continue;
		try {
			return new URL(decode(href), baseUrl).toString();
		} catch {
			// Skip malformed hrefs; a later link tag may still resolve.
		}
	}
	return null;
}

function htmlTitle(html: string): string | null {
	const raw = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
	return raw ? decode(raw).trim().slice(0, 120) || null : null;
}

async function resolveRssCandidate(input: string): Promise<ResolvedSourceCandidate> {
	const url = parseHttpUrl(input);
	if (!url) throw new Error('Enter a valid site or feed URL (http/https).');
	const body = await fetchTextForDiscovery(url.toString());
	const host = url.hostname.toLowerCase().replace(/^www\./, '');

	const directFeed = parsedFeedTitle(body);
	if (directFeed) {
		return {
			platform: 'rss',
			handle: canonicalFeedHandle(url),
			name: directFeed.title ?? host,
			siteUrl: url.origin,
			avatarUrl: null,
			acquisitionMode: 'web',
		};
	}

	const feedHref = discoverFeedHref(body, url);
	if (!feedHref) throw new Error('No RSS/Atom feed found at this URL.');
	const feedUrl = parseHttpUrl(feedHref);
	if (!feedUrl) throw new Error('Discovered feed URL is invalid.');
	const feedMeta = parsedFeedTitle(await fetchTextForDiscovery(feedUrl.toString()));
	if (!feedMeta) throw new Error('Discovered feed could not be read.');
	return {
		platform: 'rss',
		handle: canonicalFeedHandle(feedUrl),
		name: feedMeta.title ?? htmlTitle(body) ?? host,
		siteUrl: url.origin,
		avatarUrl: null,
		acquisitionMode: 'web',
	};
}

function resolveTwitterCandidate(input: string): ResolvedSourceCandidate {
	const direct = input.trim().replace(/^@/, '');
	let handle = TWITTER_HANDLE_RE.test(direct) ? direct : null;
	if (!handle) {
		const url = parseHttpUrl(input);
		const host = url?.hostname.toLowerCase().replace(/^www\./, '');
		if (url && (host === 'x.com' || host === 'twitter.com')) {
			const [segment] = url.pathname.split('/').filter(Boolean);
			if (segment && TWITTER_HANDLE_RE.test(segment)) handle = segment;
		}
	}
	if (!handle) throw new Error('Enter a valid X/Twitter handle or profile URL.');
	const lower = handle.toLowerCase();
	return {
		platform: 'twitter',
		handle: lower,
		name: `@${lower}`,
		siteUrl: `https://x.com/${lower}`,
		avatarUrl: null,
		acquisitionMode: 'platform',
	};
}

function youtubeChannelIdFromInput(input: string): string | null {
	const trimmed = input.trim();
	if (YOUTUBE_CHANNEL_ID_RE.test(trimmed)) return trimmed;
	const url = parseHttpUrl(trimmed);
	if (!url) return null;
	const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
	if (host !== 'youtube.com') return null;
	const feedChannelId = url.searchParams.get('channel_id');
	if (feedChannelId && YOUTUBE_CHANNEL_ID_RE.test(feedChannelId)) return feedChannelId;
	const segments = url.pathname.split('/').filter(Boolean);
	return segments[0] === 'channel' && segments[1] && YOUTUBE_CHANNEL_ID_RE.test(segments[1]) ? segments[1] : null;
}

function youtubeHandleFromInput(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed.startsWith('@') && YOUTUBE_HANDLE_RE.test(trimmed)) return trimmed.replace(/^@/, '');
	const url = parseHttpUrl(trimmed);
	if (!url) return null;
	const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');
	if (host !== 'youtube.com') return null;
	const [segment] = url.pathname.split('/').filter(Boolean);
	return segment?.startsWith('@') && YOUTUBE_HANDLE_RE.test(segment) ? segment.replace(/^@/, '') : null;
}

type YouTubeChannelLookup = { id: string; title: string | null; avatarUrl: string | null };

async function fetchYouTubeChannel(env: CoreEnv, query: string): Promise<YouTubeChannelLookup | null> {
	if (!env.YOUTUBE_API_KEY) throw new Error('YouTube channel lookup is not configured.');
	const response = await fetchWithTimeout(
		`https://www.googleapis.com/youtube/v3/channels?part=snippet&${query}&key=${env.YOUTUBE_API_KEY}`,
	);
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`YouTube channel lookup failed with HTTP ${status}`);
	}
	const data = (await response.json()) as {
		items?: { id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
	};
	const item = data.items?.[0];
	if (!item?.id) return null;
	return {
		id: item.id,
		title: item.snippet?.title?.trim() || null,
		avatarUrl: item.snippet?.thumbnails?.default?.url ?? null,
	};
}

async function resolveYouTubeCandidate(env: CoreEnv, input: string): Promise<ResolvedSourceCandidate> {
	const channelId = youtubeChannelIdFromInput(input);
	let channel: YouTubeChannelLookup | null;
	if (channelId) {
		// Direct ids resolve without the API being strictly necessary; the
		// lookup only enriches name/avatar, so fall back to the bare id.
		channel = (await fetchYouTubeChannel(env, `id=${channelId}`)) ?? { id: channelId, title: null, avatarUrl: null };
	} else {
		const handle = youtubeHandleFromInput(input);
		if (!handle) throw new Error('Enter a YouTube channel URL, @handle, or channel ID.');
		channel = await fetchYouTubeChannel(env, `forHandle=${encodeURIComponent(`@${handle}`)}`);
		if (!channel) throw new Error(`YouTube channel @${handle} was not found.`);
	}
	return {
		platform: 'youtube',
		handle: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`,
		name: channel.title ?? channel.id,
		siteUrl: `https://www.youtube.com/channel/${channel.id}`,
		avatarUrl: channel.avatarUrl,
		acquisitionMode: 'platform',
	};
}

export async function resolveSourceCandidate(env: CoreEnv, input: ResolveSourceCandidateInput): Promise<ResolvedSourceCandidate> {
	const raw = input.input?.trim();
	if (!raw) throw new Error('Source input is required.');
	switch (input.platform) {
		case 'rss':
			return resolveRssCandidate(raw);
		case 'twitter':
			return resolveTwitterCandidate(raw);
		case 'youtube':
			return resolveYouTubeCandidate(env, raw);
		default:
			throw new Error(`Unsupported platform: ${String(input.platform)}`);
	}
}
