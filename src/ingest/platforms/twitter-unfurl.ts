import { fetchWithTimeout, WEB_FETCH_USER_AGENT } from '@core-shared/http';
import { type PlatformMetadata, platformMetadataFor, type ResourceForProcessing } from '@core-shared/types';
import { normalizePreviewImageUrl } from '@core-shared/url';
import { decode } from 'html-entities';

// A share tweet carries only the linked URL — Kaito never returns the target
// page's OG tags — and the link-preview card renders only when externalOgImage
// exists. This is a bounded head read: no readability pass, no article extraction.

// Well-behaved pages stop at `</head>` after a few KB. The cap only binds on
// pages that inline hundreds of KB of script before their OG tags (YouTube puts
// og:image ~660 KB in), so it is set to cover those rather than to bound the norm.
const MAX_UNFURL_BYTES = 768 * 1024;
const UNFURL_HEADERS = {
	'User-Agent': WEB_FETCH_USER_AGENT,
	Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
};
const META_TAG_RE = /<meta\b[^>]*>/gi;
const ATTRIBUTE_RE = /([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const OG_IMAGE_KEYS = ['og:image', 'og:image:secure_url', 'og:image:url', 'twitter:image', 'twitter:image:src'];
const OG_TITLE_KEYS = ['og:title', 'twitter:title'];

export type TweetLinkUnfurl = { externalOgImage: string; externalTitle: string | null };

/**
 * The linked URL still missing a card image, or null when there is nothing to
 * unfurl. A page that had no OG image is retried on the next resync — it may
 * have gained one, and the fetch is bounded.
 */
export function pendingTweetExternalLink(resource: ResourceForProcessing): string | null {
	const data = platformMetadataFor(resource, 'twitter')?.data;
	const externalUrl = data?.externalUrl?.trim();
	return externalUrl && !data?.externalOgImage ? externalUrl : null;
}

function tagAttributes(tag: string): Map<string, string> {
	const attributes = new Map<string, string>();
	for (const [, name, quoted, singleQuoted, bare] of tag.matchAll(ATTRIBUTE_RE)) {
		const value = quoted ?? singleQuoted ?? bare;
		if (value !== undefined) attributes.set(name.toLowerCase(), decode(value).trim());
	}
	return attributes;
}

/** First value wins per key, matching how crawlers read duplicated OG tags. */
function metaTags(html: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const tag of html.match(META_TAG_RE) ?? []) {
		const attributes = tagAttributes(tag);
		const key = attributes.get('property') ?? attributes.get('name');
		const content = attributes.get('content');
		if (key && content && !values.has(key.toLowerCase())) values.set(key.toLowerCase(), content);
	}
	return values;
}

function firstTagValue(tags: Map<string, string>, keys: string[]): string | null {
	for (const key of keys) {
		const value = tags.get(key);
		if (value) return value;
	}
	return null;
}

function documentTitle(html: string): string | null {
	const raw = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
	return raw ? decode(raw).trim() || null : null;
}

/**
 * Read until `</head>` or the byte cap, then drop the rest. Truncating instead
 * of throwing like `readTextWithLimit` is the point: OG tags live in the head,
 * while article pages routinely exceed any cap worth setting here.
 */
async function readHtmlHead(response: Response, maxBytes: number): Promise<string> {
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

export async function unfurlTweetExternalLink(url: string): Promise<TweetLinkUnfurl | null> {
	const response = await fetchWithTimeout(url, { headers: UNFURL_HEADERS });
	if (!response.ok) {
		const status = response.status;
		await response.body?.cancel();
		throw new Error(`Tweet link unfurl failed with HTTP ${status}: ${url}`);
	}
	if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
		await response.body?.cancel();
		return null;
	}

	const html = await readHtmlHead(response, MAX_UNFURL_BYTES);
	const tags = metaTags(html);
	const image = firstTagValue(tags, OG_IMAGE_KEYS);
	// No image means no card (#234), so a title alone would never be rendered.
	if (!image) return null;
	const externalOgImage = normalizePreviewImageUrl(image, response.url || url);
	if (!externalOgImage) return null;

	return { externalOgImage, externalTitle: firstTagValue(tags, OG_TITLE_KEYS) ?? documentTitle(html) };
}

export function applyTweetLinkUnfurl(resource: ResourceForProcessing, unfurl: TweetLinkUnfurl | null): ResourceForProcessing {
	const metadata = platformMetadataFor(resource, 'twitter');
	if (!unfurl || !metadata) return resource;
	const platformMetadata: PlatformMetadata<'twitter'> = {
		...metadata,
		data: { ...metadata.data, externalOgImage: unfurl.externalOgImage, externalTitle: unfurl.externalTitle },
	};
	return { ...resource, platform_metadata: platformMetadata };
}
