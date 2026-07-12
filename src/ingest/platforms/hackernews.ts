import { generateText } from '@core-ai/generation';
import { fetchWithTimeout, readTextWithLimit } from '@core-shared/http';
import { type HackerNewsMetadata, type NormalizedContent, platformMetadataFor, type ResourceForProcessing } from '@core-shared/types';
import { decode } from 'html-entities';
import { type AcquiredWebContent, acquireWebResource } from '../web-acquisition';

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
	if (type === 'story' || type === 'ask' || type === 'show' || type === 'job') return type;
	return undefined;
}

function buildHnMetadata(item: HackerNewsItem): HackerNewsMetadata {
	return {
		itemId: item.id.toString(),
		author: item.author,
		points: item.points,
		commentCount: item.descendants,
		itemType: hnItemTypeForMetadata(item.type),
		storyUrl: item.url,
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

function buildHnPostMarkdown(item: HackerNewsItem, title: string): string {
	const parts: string[] = [`# ${title}\n`];
	const metaParts: string[] = [];
	if (item.points !== undefined) metaParts.push(`${item.points} points`);
	if (item.author) metaParts.push(`by ${item.author}`);
	if (item.descendants !== undefined) metaParts.push(`${item.descendants} comments`);
	if (metaParts.length) parts.push(`*${metaParts.join(' | ')}*\n`);
	if (item.text) parts.push(`---\n\n${htmlToText(item.text)}\n`);
	return parts.join('\n');
}

function hackerNewsItemTitle(item: HackerNewsItem, itemId: string): string {
	const title = item.title?.trim();
	if (title) return title;
	if (item.type === 'comment') return `Hacker News comment #${itemId}`;
	if (item.type === 'poll') return `Hacker News poll #${itemId}`;
	return `Hacker News item #${itemId}`;
}

export async function scrapeHackerNews(
	itemId: string,
	env: CoreEnv,
): Promise<
	NormalizedContent<'hackernews'> &
		Pick<AcquiredWebContent, 'extraction' | 'previewImageUrl'> & {
			hackerNewsItem: HackerNewsItem;
		}
> {
	console.info({ tag: 'HN', msg: 'Fetching item', itemId });
	const item = await fetchHnItem(itemId);
	const title = hackerNewsItemTitle(item, itemId);
	const hnText = item.text ? htmlToText(item.text) : '';
	if (item.type === 'comment' && !hnText) throw new Error(`Hacker News comment ${itemId} has no text`);
	let target: AcquiredWebContent | null = null;
	let markdown: string;
	let description: string | null;
	if (item.url) {
		target = await acquireWebResource(item.url, env);
		markdown = target.markdown.trim();
		description = target.metadata.description;
	} else {
		markdown = buildHnPostMarkdown(item, title);
		description = hnText.slice(0, 280) || null;
	}
	if (!markdown) throw new Error(`Hacker News item ${itemId} has no content`);
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
		markdown,
		metadata: {
			author: item.author ?? null,
			language: target?.metadata.language ?? null,
			publishedDate: item.created_at_i ? new Date(item.created_at_i * 1000).toISOString() : null,
			siteName: 'Hacker News',
			description,
		},
		platformMetadata: { fetchedAt: new Date().toISOString(), data: buildHnMetadata(item) },
		...(target?.extraction ? { extraction: target.extraction } : {}),
		...(target?.previewImageUrl ? { previewImageUrl: target.previewImageUrl } : {}),
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

const HN_DISCUSSION_HEADING = '## Hacker News community perspectives';
const HN_DISCUSSION_SYSTEM =
	'You are a professional tech news editor. Synthesize Hacker News comments into concise community perspectives. Use only the provided material. Output Markdown directly.';

function buildDiscussionPrompt(
	title: string,
	articleContent: string,
	hnText: string | null,
	commentInput: string,
	commentCount: number,
): string {
	const hnPostText = hnText ? htmlToText(hnText).slice(0, 1200) : '';
	const hnPostSection = hnPostText ? `\nHN post text:\n${hnPostText}\n` : '';
	return `Title: ${title}
Linked article or document:
${articleContent.slice(0, 8000)}
${hnPostSection}

HN comments (${commentCount} total):
${commentInput}

Write a 220-360 word community digest in English using 3-5 short paragraphs. Each paragraph should synthesize one distinct perspective found in the comments. Prioritize the strongest recurring viewpoints, meaningful disagreements, useful context, and genuine areas of agreement. Include supporting, skeptical, and supplementary perspectives only when the comments contain them.

Rules:
- Write in English
- Do not add a heading, bullets, numbering, usernames, or emoji
- Focus on how the community interpreted or challenged the material instead of restating it
- Synthesize and paraphrase; do not quote comments verbatim
- Do not invent consensus or force opposing sides when the discussion does not support them
- Keep claims from commenters clearly separate from facts established by the linked material
- Maintain a neutral, objective tone
- Output only the paragraphs, without a code block`;
}

async function generateHnDiscussionDigest(
	env: CoreEnv,
	title: string,
	articleContent: string,
	hnText: string | null,
	comments: HnCollectedComment[],
): Promise<string | null> {
	if (comments.length < 4) return null;

	const commentInput = comments
		.map((comment) => `${comment.author ? `${comment.author}: ` : ''}${comment.text}`)
		.join('\n')
		.slice(0, 30000);

	return generateText(env.AI, buildDiscussionPrompt(title, articleContent, hnText, commentInput, comments.length), {
		systemPrompt: HN_DISCUSSION_SYSTEM,
		task: 'hn-discussion-digest-en',
		gatewayId: env.AI_GATEWAY_NAME,
	});
}

function withoutPreviousDiscussion(content: string): string {
	return content.split(`\n\n---\n\n${HN_DISCUSSION_HEADING}`, 1)[0].trim();
}

export async function buildHackerNewsContent(
	resource: ResourceForProcessing,
	env: CoreEnv,
	acquiredItem?: HackerNewsItem,
): Promise<string> {
	const metadata = platformMetadataFor(resource, 'hackernews');
	const itemId = metadata?.data?.itemId;
	let item = acquiredItem;
	if (!item) {
		if (!itemId) throw new Error(`Hacker News resource ${resource.id} has no item id`);
		item = await fetchHnItem(itemId);
	}

	if (!resource.content) throw new Error(`Hacker News resource ${resource.id} has no content to annotate`);
	const articleContent = withoutPreviousDiscussion(resource.content);
	if (!articleContent) throw new Error(`Hacker News resource ${resource.id} has no content to annotate`);
	const comments = item.children?.length ? collectAllComments(item.children) : [];
	const digest = await generateHnDiscussionDigest(env, resource.title, articleContent, item.text ?? null, comments);
	const discussionUrl = `https://news.ycombinator.com/item?id=${item.id}`;
	const stats = [
		item.points !== undefined ? `${item.points} points` : null,
		item.descendants !== undefined ? `${item.descendants} comments` : null,
	]
		.filter(Boolean)
		.join(' | ');
	const links = [item.url ? `[Linked article](${item.url})` : null, `[View the full discussion](${discussionUrl})`]
		.filter(Boolean)
		.join(' | ');

	return [articleContent, '---', HN_DISCUSSION_HEADING, stats ? `*${stats}*` : null, links, digest].filter(Boolean).join('\n\n');
}
