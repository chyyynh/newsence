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
import { scrapeGenericUrl, type WebAcquiredContent } from './web';

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

function webTargetMetadata(url: string, target: WebAcquiredContent | null): NonNullable<HackerNewsMetadata['target']> {
	if (!target) return { url, status: 'unavailable' };
	const pdfData = target.type === 'pdf' && target.platformMetadata?.data ? target.platformMetadata.data : null;
	return {
		url,
		status: target.markdown.trim() ? 'fetched' : 'unavailable',
		type: target.type,
		title: target.title,
		siteName: target.metadata.siteName,
		description: target.metadata.description,
		...(pdfData ? { fileName: pdfData.fileName, fileSize: pdfData.fileSize } : {}),
	};
}

function buildHnMetadata(item: HackerNewsItem, target: WebAcquiredContent | null): HackerNewsMetadata {
	return {
		itemId: item.id.toString(),
		author: item.author ?? '',
		points: item.points ?? 0,
		commentCount: item.descendants ?? 0,
		itemType: hnItemTypeForMetadata(item.type),
		storyUrl: item.url ?? null,
		...(item.url ? { target: webTargetMetadata(item.url, target) } : {}),
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

export async function scrapeHackerNews(
	itemId: string,
	env: CoreEnv,
): Promise<
	NormalizedContent<'hackernews'> &
		Pick<WebAcquiredContent, 'extraction' | 'ogImage'> & {
			hackerNewsItem: HackerNewsItem;
		}
> {
	console.info({ tag: 'HN', msg: 'Fetching item', itemId });
	const item = await fetchHnItem(itemId);
	const title = item.title || `HN Item ${itemId}`;
	let target: WebAcquiredContent | null = null;
	if (item.url) {
		try {
			target = await scrapeGenericUrl(item.url, env);
		} catch (error) {
			console.warn({ tag: 'HN', msg: 'External target fetch failed', itemId, url: item.url, error: String(error) });
		}
	}
	const hnText = item.text ? htmlToText(item.text) : '';
	const summary = target?.metadata.description ?? (hnText.slice(0, 280) || title);
	console.info({
		tag: 'HN',
		msg: 'Item fetched',
		title,
		targetUrl: item.url ?? null,
		targetStatus: target?.markdown.trim() ? 'fetched' : 'unavailable',
	});
	return {
		type: 'hackernews',
		title,
		markdown: target?.markdown.trim() || buildHnMarkdown(item),
		metadata: {
			author: target?.metadata.author ?? item.author ?? null,
			language: target?.metadata.language ?? null,
			publishedDate: target?.metadata.publishedDate ?? (item.created_at_i ? new Date(item.created_at_i * 1000).toISOString() : null),
			siteName: target?.metadata.siteName ?? 'Hacker News',
			description: summary,
		},
		platformMetadata: { fetchedAt: new Date().toISOString(), data: buildHnMetadata(item, target) },
		...(target?.extraction?.status === 'ok' ? { extraction: target.extraction } : {}),
		...(target?.ogImage ? { ogImage: target.ogImage } : {}),
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

function buildEditorialPrompt(title: string, articleContent: string, hnText: string, commentInput: string, commentCount: number): string {
	return `Title: ${title}
Linked article or document:
${articleContent.slice(0, 8000) || 'N/A'}

HN post text:
${htmlToText(hnText).slice(0, 1200) || 'N/A'}

HN comments (${commentCount} total):
${commentInput}

Write a 180-280 word discussion digest in English using 2-4 flowing paragraphs. Do not use headings or bullet points. Briefly establish the linked material's context, then focus on the major arguments for and against, supplementary perspectives, and notable debates or consensus. Mention valuable resources from the comments only when they materially help the reader.

Rules:
- Write in English
- Do not use any emoji
- Focus on how the community reacted, not restating the resource
- Synthesize and paraphrase commenter opinions; do not translate verbatim
- Maintain a neutral, objective but engaging tone
- Output Markdown directly, do not wrap in a code block`;
}

async function generateHnEditorial(
	env: CoreEnv,
	title: string,
	articleContent: string,
	hnText: string,
	comments: HnCollectedComment[],
): Promise<string | null> {
	if (comments.length < 4) return null;

	const commentInput = comments
		.map((comment) => `${comment.author ? `${comment.author}: ` : ''}${comment.text}`)
		.join('\n')
		.slice(0, 30000);

	return generateText(env.AI, buildEditorialPrompt(title, articleContent, hnText, commentInput, comments.length), {
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

	const editorial = hnData ? await generateHnEditorial(env, resource.title, resource.content ?? '', hnData.text || '', comments) : null;

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
