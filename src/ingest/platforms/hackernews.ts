import { generateText } from '@core-ai/generation';
import {
	type HackerNewsMetadata,
	type NormalizedContent,
	type PlatformEnrichments,
	platformMetadataFor,
	type ResourceForProcessing,
} from '@core-shared/types';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/web';
import { decode } from 'html-entities';

const HN_ALGOLIA_API = 'https://hn.algolia.com/api/v1/items';
const HN_ITEM_MAX_BYTES = 5 * 1024 * 1024;

interface HnComment {
	author?: string;
	text?: string;
	children?: HnComment[];
}

export interface HackerNewsItem {
	id: number;
	title?: string;
	url?: string;
	author?: string;
	points?: number;
	descendants?: number;
	type?: 'story' | 'ask' | 'show' | 'job' | 'comment' | 'poll';
	created_at_i?: number;
	text?: string;
	children?: HnComment[];
}

export function extractHackerNewsId(url: string): string | null {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
		if (host !== 'news.ycombinator.com' && host !== 'ycombinator.com' && !host.endsWith('.ycombinator.com')) return null;
		return parsed.searchParams.get('id')?.match(/^\d+$/)?.[0] ?? null;
	} catch {
		return null;
	}
}

export function hackerNewsDiscussionUrl(value: string): string | null {
	const itemId = extractHackerNewsId(value);
	return itemId ? `https://news.ycombinator.com/item?id=${itemId}` : null;
}

function hnItemTypeForMetadata(type: HackerNewsItem['type'] | undefined): HackerNewsMetadata['itemType'] {
	if (type === 'ask' || type === 'show' || type === 'job') return type;
	return 'story';
}

function buildHnMetadata(item: HackerNewsItem): HackerNewsMetadata {
	return {
		itemId: item.id.toString(),
		author: item.author ?? '',
		points: item.points ?? 0,
		commentCount: item.descendants ?? 0,
		itemType: hnItemTypeForMetadata(item.type),
		storyUrl: item.url ?? null,
	};
}

async function fetchHnItem(itemId: string): Promise<HackerNewsItem> {
	const response = await fetchWithTimeout(`${HN_ALGOLIA_API}/${itemId}`);
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`HTTP ${response.status}: ${response.statusText}`);
	}
	return JSON.parse(await readTextWithLimit(response, HN_ITEM_MAX_BYTES)) as HackerNewsItem;
}

interface HnCollectedComment {
	author?: string;
	text: string;
}

function htmlToText(str: string): string {
	return decode(str.replace(/<[^>]*>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

function buildHnMarkdown(item: HackerNewsItem): string {
	const title = item.title || `HN Item ${item.id}`;
	const discussionUrl = `https://news.ycombinator.com/item?id=${item.id}`;
	const parts: string[] = [`# ${title}\n`];
	const metaParts: string[] = [];
	if (item.points !== undefined) metaParts.push(`${item.points} points`);
	if (item.author) metaParts.push(`by ${item.author}`);
	if (item.descendants !== undefined) metaParts.push(`${item.descendants} comments`);
	if (metaParts.length) parts.push(`*${metaParts.join(' | ')}*\n`);
	if (item.url) parts.push(`**Original:** [${item.url}](${item.url})\n`);
	if (item.text) parts.push(`---\n\n${htmlToText(item.text)}\n`);
	parts.push(`\n---\n\n[View Discussion on Hacker News](${discussionUrl})`);
	return parts.join('\n');
}

export async function scrapeHackerNews(itemId: string): Promise<NormalizedContent<'hackernews'> & { hackerNewsItem: HackerNewsItem }> {
	console.info({ tag: 'HN', msg: 'Fetching item', itemId });
	const item = await fetchHnItem(itemId);
	const title = item.title || `HN Item ${itemId}`;
	const summary = item.text ? htmlToText(item.text).slice(0, 280) : title;
	console.info({ tag: 'HN', msg: 'Item fetched', title });
	return {
		type: 'hackernews',
		title,
		markdown: buildHnMarkdown(item),
		metadata: {
			author: item.author || null,
			language: null,
			publishedDate: item.created_at_i ? new Date(item.created_at_i * 1000).toISOString() : null,
			siteName: 'Hacker News',
			description: summary,
		},
		platformMetadata: { fetchedAt: new Date().toISOString(), data: buildHnMetadata(item) },
		hackerNewsItem: item,
	};
}

function collectAllComments(children: HnComment[]): HnCollectedComment[] {
	const comments: HnCollectedComment[] = [];
	for (const child of children) {
		if (child.text) {
			const cleanText = htmlToText(child.text);
			if (cleanText) comments.push({ author: child.author, text: cleanText });
		}
		if (child.children?.length) comments.push(...collectAllComments(child.children));
	}
	return comments;
}

function extractPostLinks(externalUrl?: string | null, hnTextHtml?: string | null): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	if (externalUrl) {
		seen.add(externalUrl);
		urls.push(externalUrl);
	}
	if (hnTextHtml) {
		const hrefMatches = hnTextHtml.match(/href="([^"]+)"/g);
		for (const match of hrefMatches ?? []) {
			const raw = decode(match.slice(6, -1));
			if (!seen.has(raw) && raw.startsWith('http')) {
				seen.add(raw);
				urls.push(raw);
			}
		}
	}
	return urls;
}

const HN_EDITORIAL_SYSTEM =
	'You are a professional tech news editor. Summarize Hacker News discussions into in-depth editorial notes. Use only the provided material. Output Markdown directly.';

function buildEditorialPrompt(title: string, hnText: string, commentInput: string, commentCount: number): string {
	return `Title: ${title}
HN post text:
${htmlToText(hnText).slice(0, 1200) || 'N/A'}

HN comments (${commentCount} total):
${commentInput}

Write a 400-600 word editorial note in English using flowing paragraphs, not bullet points. Format:

## Background
2-3 sentences of context so a reader unfamiliar with the resource can quickly understand what is being discussed.

## Community Perspectives
The most important section. Summarize HN commenters' viewpoints in coherent paragraphs — major arguments for and against, interesting supplementary perspectives, and notable debates or consensus. Weave different viewpoints together naturally, like a short commentary piece.

## Further Reading
Valuable resources, tools, or links mentioned in the comments. Omit this section if none.

Rules:
- Write in English
- Do not use any emoji
- Focus on how the community reacted, not restating the resource
- Synthesize and paraphrase commenter opinions; do not translate verbatim
- Maintain a neutral, objective but engaging tone
- Output Markdown directly, do not wrap in a code block`;
}

async function generateHnEditorial(env: CoreEnv, title: string, hnText: string, comments: HnCollectedComment[]): Promise<string | null> {
	if (comments.length < 4) return null;

	const commentInput = comments
		.map((comment) => `${comment.author ? `${comment.author}: ` : ''}${comment.text}`)
		.join('\n')
		.slice(0, 30000);

	return generateText(env.AI, buildEditorialPrompt(title, hnText, commentInput, comments.length), {
		systemPrompt: HN_EDITORIAL_SYSTEM,
		task: 'hn-editorial-en',
		gatewayId: env.AI_GATEWAY_NAME,
	});
}

export async function generateHackerNewsEnrichments(
	resource: ResourceForProcessing,
	env: CoreEnv,
	acquiredItem?: HackerNewsItem,
): Promise<PlatformEnrichments> {
	const metadata = platformMetadataFor(resource, 'hackernews');
	const itemId = metadata?.data?.itemId || null;

	const hnData = acquiredItem ?? (itemId ? await fetchHnItem(itemId) : null);

	const comments = hnData?.children?.length ? collectAllComments(hnData.children) : [];

	const editorial = hnData ? await generateHnEditorial(env, resource.title, hnData.text || '', comments) : null;

	return hnData
		? {
				hnUrl: `https://news.ycombinator.com/item?id=${hnData.id}`,
				externalUrl: hnData.url || null,
				hnText: hnData.text || null,
				editorial,
				commentCount: comments.length,
				links: extractPostLinks(hnData.url, hnData.text),
			}
		: {};
}
