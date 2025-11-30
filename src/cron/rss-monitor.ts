import { XMLParser } from 'fast-xml-parser';
import { Env, ExecutionContext } from '../types';
import { getSupabaseClient } from '../utils/supabase';
import { normalizeUrl, scrapeArticleContent } from '../utils/rss';

type RSSItem = any;

function getArticlesTable(env: Env): string {
	return env.ARTICLES_TABLE || 'articles_test_core';
}

async function processAndInsertArticle(
	supabase: any,
	env: Env,
	item: RSSItem,
	feed: any,
	sourceType: string
) {
	const pubDate = item.pubDate || item.isoDate || item.published || item.updated || null;

	// Resolve URL with multiple fallbacks (RSS/Atom/RDF)
	let url: string | null = null;
	if (typeof item.link === 'string') url = item.link;
	else if (item.link?.['@_href']) url = item.link['@_href'];
	else if (item.link?.href) url = item.link.href;
	else if (item.url) url = item.url;

	url = url ? normalizeUrl(url) : null;

	// Scrape content if URL exists
	let crawled_content = '';
	if (url) {
		try {
			crawled_content = await scrapeArticleContent(url);
		} catch (err) {
			console.warn(`[${feed.name}] scrape failed for ${url}:`, err);
			crawled_content = '';
		}
	}

	const insert = {
		url: url || `feed:${feed.id}:${Date.now()}`,
		title: item.title || item.text || item.news_title || 'No Title',
		source: feed.name || 'Unknown',
		published_date: pubDate ? new Date(pubDate) : new Date(),
		scraped_date: new Date(),
		keywords: [],
		tags: [],
		tokens: [],
		summary: '',
		source_type: sourceType,
		content: crawled_content || item.description || item.summary || '',
	};

	const table = getArticlesTable(env);
	const { data: inserted, error } = await supabase.from(table).insert([insert]).select('id');

	if (error) {
		console.error(`[${feed.name}] insert error:`, error);
		return;
	}

	const articleId = inserted?.[0]?.id;
	if (!articleId) return;

	try {
		await env.RSS_QUEUE.send({
			type: 'article_scraped',
			article_id: articleId,
			url: insert.url,
			source: insert.source,
			source_type: insert.source_type,
			timestamp: new Date().toISOString()
		});
		console.log(`[${feed.name}] queued article ${articleId}`);
	} catch (err) {
		console.error(`[${feed.name}] queue send failed:`, err);
	}
}

export async function handleRSSCron(env: Env, _ctx: ExecutionContext) {
	console.log('[RSS] cron trigger start');
	const supabase = getSupabaseClient(env);
	const parser = new XMLParser({ ignoreAttributes: false });

	const { data: feeds, error: feedErr } = await supabase
		.from('RssList')
		.select('id, name, RSSLink, url, type');

	if (feedErr) {
		console.error('[RSS] failed to fetch RssList:', feedErr);
		return;
	}

	const tasks = (feeds || []).map(async (feed: any) => {
		if (feed.type !== 'rss') {
			console.log(`[${feed.name}] skip non-rss type`);
			return;
		}

		const res = await fetch(feed.RSSLink, {
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				Accept: 'application/rss+xml, application/xml, text/xml, */*',
			},
		});

		if (!res.ok) {
			console.warn(`[${feed.name}] fetch failed: ${res.status} ${res.statusText}`);
			return;
		}

		const xml = await res.text();
		const data = parser.parse(xml);

		let items: RSSItem[] = [];
		if (data?.rss?.channel?.item) items = Array.isArray(data.rss.channel.item) ? data.rss.channel.item : [data.rss.channel.item];
		else if (data?.feed?.entry) items = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
		else if (data?.channel?.item) items = Array.isArray(data.channel.item) ? data.channel.item : [data.channel.item];
		else if (data?.['rdf:RDF']?.item) items = Array.isArray(data['rdf:RDF'].item) ? data['rdf:RDF'].item : [data['rdf:RDF'].item];

		if (!items.length) {
			console.log(`[${feed.name}] no items`);
			return;
		}

		// Deduplicate by URL against DB
		const urls = items
			.map((item) => {
				let url: string | null = null;
				if (typeof item.link === 'string') url = item.link;
				else if (item.link?.['@_href']) url = item.link['@_href'];
				else if (item.link?.href) url = item.link.href;
				else if (item.url) url = item.url;
				return url ? normalizeUrl(url) : null;
			})
			.filter(Boolean) as string[];

		const table = getArticlesTable(env);
		const { data: existing, error: existErr } = await supabase
			.from(table)
			.select('url')
			.in('url', urls);

		if (existErr) {
			console.error(`[${feed.name}] check existing failed:`, existErr);
			return;
		}

		const existingSet = new Set((existing || []).map((e: any) => normalizeUrl(e.url)));
		const newItems = items.filter((item) => {
		 let u: string | null = null;
		 if (typeof item.link === 'string') u = item.link;
		 else if (item.link?.['@_href']) u = item.link['@_href'];
		 else if (item.link?.href) u = item.link.href;
		 else if (item.url) u = item.url;
		 return u && !existingSet.has(normalizeUrl(u));
		});

		console.log(`[${feed.name}] new items: ${newItems.length}/${items.length}`);
		for (const item of newItems) {
			await processAndInsertArticle(supabase, env, item, feed, 'rss');
		}

		await supabase
			.from('RssList')
			.update({ scraped_at: new Date(), url: feed.url })
			.eq('id', feed.id);
	});

	await Promise.allSettled(tasks);
	console.log('[RSS] cron trigger end');
}
