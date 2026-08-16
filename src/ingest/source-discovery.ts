import { fetchWithTimeout, readTextWithLimit, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { isSourcePlatform, SOURCE_INPUT_MAX_LENGTH, type SourceAcquisitionMode, type SourcePlatform } from '@core-shared/resource-types';
import { parseFeed } from 'feedsmith';
import { decode } from 'html-entities';

// Resolves user input (site URL / feed URL / handle / channel URL) into the
// exact source row the crons can monitor. Owns the acquisition-layer facts —
// which feed URL a platform fetches — so the app worker never encodes them.

export type ResolveSourceCandidateInput = { platform: SourcePlatform; input: string };

type ResolvedSourceCandidate = {
	platform: SourcePlatform;
	handle: string;
	name: string;
	siteUrl: string | null;
	avatarUrl: string | null;
	acquisitionMode: SourceAcquisitionMode;
	/** Minimum minutes between polls; omitted means every cron firing. */
	pollIntervalMinutes?: number;
};

const MAX_DISCOVERY_BYTES = 1024 * 1024;
const FEED_MIME_TYPES = new Set(['application/atom+xml', 'application/rss+xml']);
/** Channels publish on the order of once a day; the RSS default of every 5 minutes is waste. */
const YOUTUBE_POLL_INTERVAL_MINUTES = 30;
const TWITTER_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_HANDLE_RE = /^@?[A-Za-z0-9._-]{3,30}$/;

const DISCOVERY_HEADERS = {
	'User-Agent': WEB_FETCH_USER_AGENT,
	Accept: 'application/rss+xml, application/atom+xml, application/feed+json, text/html, application/xml, text/xml, */*',
};

type HtmlHead = {
	title: string | null;
	feedHref: string | null;
	meta: ReadonlyMap<string, string>;
};

function decodedAttribute(element: Element, name: string): string | null {
	const value = element.getAttribute(name);
	return value === null ? null : decode(value).trim();
}

function isAlternateFeedLink(element: Element): boolean {
	const rel = decodedAttribute(element, 'rel');
	if (!rel?.split(/\s+/).some((token) => token.toLowerCase() === 'alternate')) return false;
	const type = decodedAttribute(element, 'type')?.split(';', 1)[0]?.trim().toLowerCase();
	return type !== undefined && FEED_MIME_TYPES.has(type);
}

/** Parse already-bounded HTML with the Workers-native streaming parser. */
export async function parseHtmlHead(html: string, baseUrl?: URL): Promise<HtmlHead> {
	const meta = new Map<string, string>();
	let feedHref: string | null = null;
	let title: string | null = null;
	let titleChunks: string[] | null = null;
	let titleSeen = false;

	const rewriter = new HTMLRewriter()
		.on('link', {
			element(element) {
				if (feedHref !== null || !baseUrl || !isAlternateFeedLink(element)) return;
				const href = decodedAttribute(element, 'href');
				if (!href) return;
				try {
					feedHref = new URL(href, baseUrl).toString();
				} catch {
					// Skip malformed hrefs; a later link tag may still resolve.
				}
			},
		})
		.on('meta', {
			element(element) {
				const key = decodedAttribute(element, 'property') ?? decodedAttribute(element, 'name');
				const content = decodedAttribute(element, 'content');
				if (!key || !content) return;
				const normalizedKey = key.toLowerCase();
				if (!meta.has(normalizedKey)) meta.set(normalizedKey, content);
			},
		})
		.on('title', {
			element(element) {
				if (titleSeen || titleChunks !== null) return;
				titleChunks = [];
				element.onEndTag(() => {
					if (titleSeen || titleChunks === null) return;
					title = decode(titleChunks.join('')).trim() || null;
					titleChunks = null;
					titleSeen = true;
				});
			},
			text(chunk) {
				if (!titleSeen && titleChunks !== null) titleChunks.push(chunk.text);
			},
		});

	// HTMLRewriter handlers run while the transformed body is consumed. The
	// input is already byte-bounded by the caller, so buffering the discarded
	// output cannot turn an unbounded response into isolate memory pressure.
	await rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).arrayBuffer();
	return { title, feedHref, meta };
}

export function firstHtmlMetaValue(head: HtmlHead, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = head.meta.get(key);
		if (value) return value;
	}
	return null;
}

/**
 * Read through the closing head tag or byte cap, then cancel the origin body.
 * The cap intentionally truncates instead of throwing because head metadata is
 * useful even when a page inlines a very large script before it.
 */
export async function readHtmlHead(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let html = '';
	let totalBytes = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return html + decoder.decode();

			totalBytes += value.byteLength;
			html += decoder.decode(value, { stream: true });
			if (totalBytes >= maxBytes || /<\/head\s*>/i.test(html)) {
				await reader.cancel();
				return html;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

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

type DiscoveryDocument = {
	body: string;
	url: URL;
};

async function fetchTextForDiscovery(url: string): Promise<DiscoveryDocument> {
	const response = await fetchWithTimeout(url, { headers: DISCOVERY_HEADERS });
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`Fetch failed with HTTP ${status}: ${url}`);
	}
	const effectiveUrl = parseHttpUrl(response.url);
	if (!effectiveUrl) {
		await response.body?.cancel();
		throw new Error('Fetch redirected to an invalid URL.');
	}
	return {
		body: await readTextWithLimit(response, MAX_DISCOVERY_BYTES),
		url: effectiveUrl,
	};
}

async function resolveRssCandidate(input: string): Promise<ResolvedSourceCandidate> {
	const requestedUrl = parseHttpUrl(input);
	if (!requestedUrl) throw new Error('Enter a valid site or feed URL (http/https).');
	const document = await fetchTextForDiscovery(requestedUrl.toString());
	const host = document.url.hostname.toLowerCase().replace(/^www\./, '');

	const directFeed = parsedFeedTitle(document.body);
	if (directFeed) {
		return {
			platform: 'rss',
			handle: canonicalFeedHandle(document.url),
			name: directFeed.title ?? host,
			siteUrl: document.url.origin,
			avatarUrl: null,
			acquisitionMode: 'web',
		};
	}

	const head = await parseHtmlHead(document.body, document.url);
	const feedHref = head.feedHref;
	if (!feedHref) throw new Error('No RSS/Atom feed found at this URL.');
	const requestedFeedUrl = parseHttpUrl(feedHref);
	if (!requestedFeedUrl) throw new Error('Discovered feed URL is invalid.');
	const feedDocument = await fetchTextForDiscovery(requestedFeedUrl.toString());
	const feedMeta = parsedFeedTitle(feedDocument.body);
	if (!feedMeta) throw new Error('Discovered feed could not be read.');
	return {
		platform: 'rss',
		handle: canonicalFeedHandle(feedDocument.url),
		name: feedMeta.title ?? head.title?.slice(0, 120) ?? host,
		siteUrl: document.url.origin,
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
		// The handle is an Atom feed, so the RSS monitor polls it and each entry is
		// acquired from its own URL — 'web', not 'platform'. Channels publish far
		// less often than a news feed, so they opt out of the 5-minute cadence.
		acquisitionMode: 'web',
		pollIntervalMinutes: YOUTUBE_POLL_INTERVAL_MINUTES,
	};
}

export async function resolveSourceCandidate(env: CoreEnv, input: ResolveSourceCandidateInput): Promise<ResolvedSourceCandidate> {
	if (!isSourcePlatform(input.platform)) throw new Error('Unsupported source platform.');
	const raw = typeof input.input === 'string' ? input.input.trim() : '';
	if (!raw) throw new Error('Source input is required.');
	if (raw.length > SOURCE_INPUT_MAX_LENGTH) throw new Error('Source input is too long.');
	switch (input.platform) {
		case 'rss':
			return resolveRssCandidate(raw);
		case 'twitter':
			return resolveTwitterCandidate(raw);
		case 'youtube':
			return resolveYouTubeCandidate(env, raw);
	}
}
