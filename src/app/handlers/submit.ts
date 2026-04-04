import { detectPlatformType, type ScrapedContent, scrapeUrl } from '../../domain/scrapers';
import { ARTICLES_TABLE, createDbClient, USER_ARTICLES_TABLE } from '../../infra/db';
import { logError, logInfo, logWarn } from '../../infra/log';
import { normalizeUrl } from '../../infra/web';
import type { PlatformMetadata } from '../../models/platform-metadata';
import {
	buildDefault,
	buildHackerNews,
	buildTwitterArticle,
	buildTwitterShared,
	buildTwitterStandard,
	buildYouTube,
} from '../../models/platform-metadata';
import type { Env, TelegramNotifyContext } from '../../models/types';
import { isSubmitAuthorized, validateOrgMembership } from '../middleware/auth';
import {
	DEFAULT_SUBMIT_RATE_LIMIT_MAX,
	DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC,
	getSubmitRateKey,
	hitSubmitRateLimit,
} from '../middleware/rate-limit';

const EXIST_COLS = 'id, title, title_cn, summary_cn, tags, source_type, og_image_url';

type SubmitBody = {
	url?: string; // Legacy single URL (backward compatible)
	urls?: string[]; // Batch URLs
	userId?: string;
	organizationId?: string;
	visibility?: 'public' | 'private'; // For user_articles; defaults to 'public'
	notifyContext?: {
		platform: 'telegram';
		chatId: string;
		messageId: string;
		linked: boolean;
		userId: string;
		webappUrl: string;
	};
};

type SubmitResult = {
	url: string;
	articleId?: string;
	instanceId?: string;
	title?: string;
	titleCn?: string;
	summaryCn?: string;
	tags?: string[];
	ogImageUrl?: string | null;
	sourceType?: string;
	alreadyExists?: boolean;
	isUserArticle?: boolean;
	error?: string;
};

async function createWorkflow(
	env: Env,
	articleId: string,
	sourceType: string,
	notifyContext?: TelegramNotifyContext,
	targetTable?: string,
): Promise<string | undefined> {
	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			params: {
				article_id: articleId,
				source_type: sourceType,
				...(notifyContext ? { notify_context: notifyContext } : {}),
				...(targetTable ? { target_table: targetTable } : {}),
			},
		});
		return instance.id;
	} catch (err) {
		logError('SUBMIT', 'Workflow create failed', { articleId, error: String(err) });
		return undefined;
	}
}

async function scrapeAndInsert(
	url: string,
	env: Env,
	userId?: string,
	targetTable?: string,
	visibility = 'public',
	organizationId?: string,
): Promise<{ articleId: string; scraped: ScrapedContent; platformType: string } | { error: string }> {
	const platformType = detectPlatformType(url);
	const scraped = await scrapeUrl(url, {
		youtubeApiKey: env.YOUTUBE_API_KEY,
		kaitoApiKey: env.KAITO_API_KEY,
	});

	const skipContentCheck = platformType === 'youtube' || platformType === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return { error: 'Content too short' };
	}

	const db = await createDbClient(env);
	try {
		const table = targetTable ?? ARTICLES_TABLE;
		const isUserArticle = table === USER_ARTICLES_TABLE;
		const normalizedPlatformMetadata = normalizePlatformMetadata(scraped.metadata, platformType);
		const platformMetadataJson = normalizedPlatformMetadata
			? JSON.stringify({
					...normalizedPlatformMetadata,
					ogImageWidth: scraped.ogImageWidth ?? null,
					ogImageHeight: scraped.ogImageHeight ?? null,
				})
			: null;

		let insertResult: { rows: { id: string }[] };
		if (isUserArticle) {
			insertResult = await db.query(
				`INSERT INTO ${table}
					(url, title, source, published_date, scraped_date, summary, source_type, content, og_image_url, keywords, tags, platform_metadata, user_id, visibility, organization_id)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
				RETURNING id`,
				[
					url,
					scraped.title,
					scraped.siteName || 'External',
					scraped.publishedDate || new Date().toISOString(),
					new Date().toISOString(),
					scraped.summary || '',
					platformType,
					scraped.content || null,
					scraped.ogImageUrl || null,
					[],
					[],
					platformMetadataJson,
					userId,
					visibility,
					organizationId || null,
				],
			);
		} else {
			insertResult = await db.query(
				`INSERT INTO ${table}
					(url, title, source, published_date, scraped_date, summary, source_type, content, og_image_url, keywords, tags, tokens, platform_metadata)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
				RETURNING id`,
				[
					url,
					scraped.title,
					scraped.siteName || 'External',
					scraped.publishedDate || new Date().toISOString(),
					new Date().toISOString(),
					scraped.summary || '',
					platformType,
					scraped.content || null,
					scraped.ogImageUrl || null,
					[],
					[],
					[],
					platformMetadataJson,
				],
			);
		}

		const inserted = insertResult.rows;
		if (!inserted?.[0]?.id) {
			logError('SUBMIT', 'DB insert failed', { url, error: 'No id returned' });
			return { error: 'DB insert failed' };
		}

		// Save YouTube transcript to dedicated table (after article insert so no orphans)
		if (scraped.youtubeTranscript) {
			const yt = scraped.youtubeTranscript;
			try {
				await db.query(
					`INSERT INTO youtube_transcripts (video_id, transcript, language, chapters, chapters_from_description, fetched_at)
					VALUES ($1, $2, $3, $4, $5, $6)
					ON CONFLICT (video_id) DO UPDATE SET
						transcript = EXCLUDED.transcript,
						language = EXCLUDED.language,
						chapters = EXCLUDED.chapters,
						chapters_from_description = EXCLUDED.chapters_from_description,
						fetched_at = EXCLUDED.fetched_at`,
					[
						yt.videoId,
						JSON.stringify(yt.segments),
						yt.language,
						yt.chapters ? JSON.stringify(yt.chapters) : null,
						yt.chaptersFromDescription,
						new Date().toISOString(),
					],
				);
			} catch (transcriptErr) {
				logError('YOUTUBE', 'Failed to save transcript', { videoId: yt.videoId, error: String(transcriptErr) });
			}
		}

		logInfo('SUBMIT', 'Saved raw article', { title: scraped.title.slice(0, 50), table });
		return { articleId: inserted[0].id, scraped, platformType };
	} catch (err) {
		logError('SUBMIT', 'DB insert failed', { url, error: String(err) });
		return { error: 'DB insert failed' };
	} finally {
		await db.end();
	}
}

/**
 * If the row is already processed (has title_cn), skip workflow. Otherwise create one.
 * Returns the existing-article SubmitResult.
 */
async function returnExisting(
	url: string,
	row: Record<string, string>,
	env: Env,
	notifyContext: Omit<TelegramNotifyContext, 'articleId' | 'alreadyExists'> | undefined,
	isUserArticle: boolean,
	targetTable?: string,
): Promise<SubmitResult> {
	const enrichedNotify = notifyContext
		? { ...notifyContext, articleId: row.id, alreadyExists: true, ...(isUserArticle ? { isUserArticle: true } : {}) }
		: undefined;
	const instanceId = row.title_cn
		? undefined
		: await createWorkflow(env, row.id, row.source_type || 'article', enrichedNotify, targetTable);
	return {
		url,
		articleId: row.id,
		instanceId,
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags ? (Array.isArray(row.tags) ? row.tags : []) : undefined,
		ogImageUrl: row.og_image_url,
		sourceType: row.source_type,
		alreadyExists: true,
		isUserArticle,
	};
}

/**
 * Copy a public article row into user_articles so it appears in all user-scoped queries (export, library, etc.).
 * Returns the new user_articles row (with EXIST_COLS) on success, or null if the copy failed / already existed.
 */
async function copyArticleToUserTable(
	db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
	articleId: string,
	userId: string,
	organizationId?: string,
	visibility = 'public',
): Promise<Record<string, string> | null> {
	const COPY_COLS =
		'url, title, title_cn, source, published_date, scraped_date, keywords, tags, summary, summary_cn, source_type, content, content_cn, og_image_url, platform_metadata, embedding';
	try {
		const result = await db.query(
			`INSERT INTO ${USER_ARTICLES_TABLE} (${COPY_COLS}, user_id, organization_id, visibility)
			SELECT ${COPY_COLS}, $2, $3, $4
			FROM ${ARTICLES_TABLE} WHERE id = $1
			ON CONFLICT DO NOTHING
			RETURNING ${EXIST_COLS}`,
			[articleId, userId, organizationId || null, visibility],
		);
		if (result.rows[0]) return result.rows[0] as Record<string, string>;
		// ON CONFLICT — row already exists, look it up
		const lookup = organizationId
			? await db.query(
					`SELECT ${EXIST_COLS} FROM ${USER_ARTICLES_TABLE} WHERE organization_id = $1 AND url = (SELECT url FROM ${ARTICLES_TABLE} WHERE id = $2) LIMIT 1`,
					[organizationId, articleId],
				)
			: await db.query(
					`SELECT ${EXIST_COLS} FROM ${USER_ARTICLES_TABLE} WHERE user_id = $1 AND organization_id IS NULL AND url = (SELECT url FROM ${ARTICLES_TABLE} WHERE id = $2) LIMIT 1`,
					[userId, articleId],
				);
		return (lookup.rows[0] as Record<string, string>) ?? null;
	} catch (err) {
		logWarn('SUBMIT', 'Failed to copy article to user_articles', { articleId, error: String(err) });
		return null;
	}
}

/**
 * URL processing: scrape + DB insert + create Workflow (no waiting for AI)
 * Returns immediately with articleId + instanceId, AI processing happens in background via Workflow
 */
export async function processUrl(
	rawUrl: string,
	env: Env,
	userId?: string,
	notifyContext?: Omit<TelegramNotifyContext, 'articleId' | 'alreadyExists'>,
	visibility = 'public',
	organizationId?: string,
): Promise<SubmitResult> {
	const url = normalizeUrl(rawUrl);

	// 1. Check for existing article — close connection before any addToUnsortedCollection calls
	let existingRow: Record<string, string> | null = null;
	let existingIsUserArticle = false;
	const db = await createDbClient(env);
	try {
		if (userId) {
			// Check user_articles first (exact user/org scope), then public articles
			const uaQuery = organizationId
				? `SELECT ${EXIST_COLS} FROM ${USER_ARTICLES_TABLE} WHERE organization_id = $1 AND url = $2 LIMIT 1`
				: `SELECT ${EXIST_COLS} FROM ${USER_ARTICLES_TABLE} WHERE user_id = $1 AND organization_id IS NULL AND url = $2 LIMIT 1`;
			const ua = await db.query(uaQuery, [organizationId || userId, url]);
			if (ua.rows.length > 0) {
				existingRow = ua.rows[0];
				existingIsUserArticle = true;
			} else {
				const pub = await db.query(`SELECT ${EXIST_COLS} FROM ${ARTICLES_TABLE} WHERE url = $1 LIMIT 1`, [url]);
				if (pub.rows.length > 0) {
					// Public article exists — copy to user_articles so all user-scoped queries see it
					const copied = await copyArticleToUserTable(db, pub.rows[0].id, userId, organizationId, visibility);
					existingRow = copied ?? pub.rows[0];
					existingIsUserArticle = !!copied;
				}
			}
		} else {
			const existing = await db.query(`SELECT ${EXIST_COLS} FROM ${ARTICLES_TABLE} WHERE url = $1`, [url]);
			if (existing.rows.length > 0) return returnExisting(url, existing.rows[0], env, notifyContext, false);
		}
	} finally {
		await db.end();
	}

	// Handle existing article — add to unsorted (connection now closed, addToUnsortedCollection manages its own)
	if (existingRow && userId) {
		await addToUnsortedCollection(env, userId, existingRow.id, organizationId, existingIsUserArticle ? 'user_article' : 'article').catch(
			(err) => logWarn('SUBMIT', 'Failed to add existing to unsorted', { error: String(err) }),
		);
		return returnExisting(
			url,
			existingRow,
			env,
			notifyContext,
			existingIsUserArticle,
			existingIsUserArticle ? USER_ARTICLES_TABLE : undefined,
		);
	}
	if (existingRow) {
		return returnExisting(url, existingRow, env, notifyContext, false);
	}

	// 2. Scrape + insert (user → user_articles, system → articles)
	const targetTable = userId ? USER_ARTICLES_TABLE : undefined;
	let result: Awaited<ReturnType<typeof scrapeAndInsert>>;
	try {
		result = await scrapeAndInsert(url, env, userId, targetTable, visibility, organizationId);
	} catch (err) {
		logError('SUBMIT', 'Scrape failed', { url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };

	// 3. Auto-add to unsorted collection (if user-submitted)
	if (userId) {
		try {
			await addToUnsortedCollection(env, userId, result.articleId, organizationId, userId ? 'user_article' : 'article');
		} catch (err) {
			logWarn('SUBMIT', 'Failed to add to unsorted collection', { error: String(err) });
		}
	}

	// 4. Create workflow for background AI processing
	const enrichedNotify = notifyContext
		? { ...notifyContext, articleId: result.articleId, alreadyExists: false, ...(userId ? { isUserArticle: true } : {}) }
		: undefined;
	const instanceId = await createWorkflow(env, result.articleId, result.platformType, enrichedNotify, targetTable);
	return {
		url,
		articleId: result.articleId,
		instanceId,
		title: result.scraped.title,
		ogImageUrl: result.scraped.ogImageUrl || null,
		sourceType: result.platformType,
		alreadyExists: false,
		isUserArticle: !!userId,
	};
}

export async function handleSubmitUrl(request: Request, env: Env): Promise<Response> {
	if (!(await isSubmitAuthorized(request, env))) {
		return Response.json(
			{ success: false, error: { code: 'UNAUTHORIZED', message: 'Missing or invalid internal token' } },
			{ status: 401 },
		);
	}

	let body: SubmitBody;
	try {
		body = (await request.json()) as SubmitBody;
	} catch {
		return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	// Support both legacy `url` and new `urls` format
	const urls = body.urls ?? (body.url ? [body.url] : []);
	if (urls.length === 0) {
		return Response.json({ error: 'Missing url or urls field' }, { status: 400 });
	}

	const MAX_BATCH_SIZE = 20;
	if (urls.length > MAX_BATCH_SIZE) {
		return Response.json(
			{
				success: false,
				error: { code: 'BATCH_TOO_LARGE', message: `Maximum ${MAX_BATCH_SIZE} URLs per request, got ${urls.length}` },
			},
			{ status: 400 },
		);
	}

	const max = Number.parseInt(env.SUBMIT_RATE_LIMIT_MAX || '', 10) || DEFAULT_SUBMIT_RATE_LIMIT_MAX;
	const windowSec = Number.parseInt(env.SUBMIT_RATE_LIMIT_WINDOW_SEC || '', 10) || DEFAULT_SUBMIT_RATE_LIMIT_WINDOW_SEC;
	const rateKey = getSubmitRateKey(request, body.userId);
	const rateResult = hitSubmitRateLimit(rateKey, Math.max(max, 1), Math.max(windowSec, 1), urls.length);
	if (rateResult.limited) {
		return Response.json(
			{
				success: false,
				error: { code: 'RATE_LIMITED', message: `Too many submit requests. Retry in ${rateResult.retryAfterSec}s` },
			},
			{ status: 429, headers: { 'Retry-After': String(rateResult.retryAfterSec) } },
		);
	}

	logInfo('SUBMIT', 'Processing URLs', { count: urls.length });
	const userId = body.userId;
	let organizationId = body.organizationId;
	// Validate org membership — reject spoofed organizationId
	if (organizationId && userId) {
		const isMember = await validateOrgMembership(env, userId, organizationId);
		if (!isMember) {
			return Response.json(
				{ success: false, error: { code: 'FORBIDDEN', message: 'User is not a member of this organization' } },
				{ status: 403 },
			);
		}
	} else if (organizationId && !userId) {
		organizationId = undefined; // org without user makes no sense
	}
	const articleVisibility = body.visibility ?? 'public';
	// Only pass notifyContext for single-URL submissions (bot sends one at a time)
	const notifyCtx = urls.length === 1 && body.notifyContext ? body.notifyContext : undefined;
	const results = await Promise.all(urls.map((url) => processUrl(url, env, userId, notifyCtx, articleVisibility, organizationId)));
	return Response.json({ success: true, results });
}

/** Get or create the system "Unsorted" collection. Caller manages the db lifecycle. */
export async function getOrCreateUnsortedCollection(
	db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
	userId: string,
	orgId: string | null,
): Promise<string | null> {
	const existing = orgId
		? await db.query(`SELECT id FROM collections WHERE is_system = true AND organization_id = $1 LIMIT 1`, [orgId])
		: await db.query(`SELECT id FROM collections WHERE is_system = true AND user_id = $1 AND organization_id IS NULL LIMIT 1`, [userId]);
	if (existing.rows[0]) return existing.rows[0].id as string;

	const ins = await db.query(
		`INSERT INTO collections (user_id, organization_id, name, is_system, visibility, article_count)
		VALUES ($1, $2, 'Unsorted', true, 'private', 0)
		ON CONFLICT DO NOTHING
		RETURNING id`,
		[userId, orgId],
	);
	if (ins.rows[0]) return ins.rows[0].id as string;

	// Race: another request created it first, re-query
	const retry = orgId
		? await db.query(`SELECT id FROM collections WHERE is_system = true AND organization_id = $1 LIMIT 1`, [orgId])
		: await db.query(`SELECT id FROM collections WHERE is_system = true AND user_id = $1 AND organization_id IS NULL LIMIT 1`, [userId]);
	return (retry.rows[0]?.id as string) ?? null;
}

async function addToUnsortedCollection(
	env: Env,
	userId: string,
	articleId: string,
	organizationId?: string,
	toType = 'article',
): Promise<void> {
	const db = await createDbClient(env);
	try {
		const orgId = organizationId || null;
		const collectionId = await getOrCreateUnsortedCollection(db, userId, orgId);
		if (!collectionId) return;

		await db.query(
			`INSERT INTO citations (from_type, from_id, to_type, to_id, relation_type, user_id, organization_id)
			VALUES ('collection', $1, $2, $3, 'resource', $4, $5)
			ON CONFLICT DO NOTHING`,
			[collectionId, toType, articleId, userId, orgId],
		);
		// articleCount is maintained by DB trigger on citations table
	} finally {
		await db.end();
	}
}

function normalizePlatformMetadata(metadata: Record<string, unknown> | undefined, fallbackType: string): PlatformMetadata | null {
	if (!metadata) return null;
	const rawType = metadata.type;
	const type = typeof rawType === 'string' && rawType.trim().length > 0 ? rawType : fallbackType;

	switch (type) {
		case 'youtube':
			return buildYouTube({
				videoId: (metadata.videoId as string) || '',
				channelName: (metadata.channelName as string) || '',
				channelId: metadata.channelId as string | undefined,
				channelAvatar: metadata.channelAvatar as string | undefined,
				duration: metadata.duration as string | undefined,
				thumbnailUrl: metadata.thumbnailUrl as string | undefined,
				viewCount: metadata.viewCount as number | undefined,
				likeCount: metadata.likeCount as number | undefined,
				commentCount: metadata.commentCount as number | undefined,
				publishedAt: metadata.publishedAt as string | undefined,
				description: metadata.description as string | undefined,
				tags: metadata.tags as string[] | undefined,
			});
		case 'hackernews':
			return buildHackerNews({
				itemId: (metadata.itemId as string) || '',
				author: (metadata.author as string) || '',
				points: (metadata.points as number) || 0,
				commentCount: (metadata.commentCount as number) || 0,
				itemType: metadata.itemType as 'story' | 'ask' | 'show' | 'job' | undefined,
				storyUrl: metadata.storyUrl as string | null | undefined,
			});
		case 'twitter': {
			const author = {
				authorName: (metadata.authorName as string) || '',
				authorUserName: (metadata.authorUserName as string) || '',
				authorProfilePicture: metadata.authorProfilePicture as string | undefined,
			};
			const variant = metadata.variant as string | undefined;
			if (variant === 'shared') {
				return buildTwitterShared(author, {
					media: (metadata.media as Array<{ url: string; type: 'photo' | 'video' | 'animated_gif' }>) || [],
					createdAt: metadata.createdAt as string | undefined,
					tweetText: metadata.tweetText as string | undefined,
					externalUrl: (metadata.externalUrl as string) || '',
					externalOgImage: metadata.externalOgImage as string | null | undefined,
					externalTitle: metadata.externalTitle as string | null | undefined,
				});
			}
			if (variant === 'article') {
				return buildTwitterArticle(author);
			}
			return buildTwitterStandard(author, {
				media: (metadata.media as Array<{ url: string; type: 'photo' | 'video' | 'animated_gif' }>) || [],
				createdAt: metadata.createdAt as string | undefined,
			});
		}
		default:
			return buildDefault();
	}
}
