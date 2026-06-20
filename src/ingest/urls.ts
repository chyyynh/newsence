import { withDbClient } from '@shared/db';
import { PDF_MIME } from '@shared/mime';
import { parsePlatformMetadata } from '@shared/platform-metadata';
import type { Env } from '@shared/types';
import { detectPlatformType, normalizeUrl, type ScrapedContent, validateImageUrl } from '@shared/web';
import { createUserFileWorkflow } from '@shared/workflow-queue';
import { upsertYoutubeTranscript } from '@shared/youtube-transcripts';
import { persistSavedUrlBlob } from './blob-persistence';
import { type ScrapeResult, scrapeUrl } from './platforms/registry';
import {
	type ExistingUrlUserFile,
	getUrlUserFileByNormalizedSourceUrl,
	type InsertUrlUserFileResult,
	insertUrlUserFile,
} from './url-user-files';

const INGEST_MAX_BATCH_SIZE = 20;
const INGEST_URL_CONCURRENCY = 4;

type IngestResult = {
	url: string;
	userFileId?: string;
	instanceId?: string;
	title?: string;
	titleCn?: string;
	summaryCn?: string;
	tags?: string[];
	ogImageUrl?: string | null;
	resourceKind?: 'url' | 'blob';
	originType?: 'saved_url';
	platformType?: string;
	fileType?: string;
	alreadyExists?: boolean;
	error?: string;
};

type IngestErrorCode = 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED';
export type IngestUrlsOutcome = { ok: true; results: IngestResult[] } | { ok: false; code: IngestErrorCode; message: string };

type InsertOutcome =
	| { kind: 'page'; row: InsertUrlUserFileResult }
	| { kind: 'blob'; userFileId: string; fileType: string }
	| { error: string };

type UserFileUrlResultRow = Pick<
	ExistingUrlUserFile,
	'id' | 'title' | 'title_cn' | 'summary_cn' | 'tags' | 'platform_type' | 'og_image_url'
>;

async function insertScrapedPage(scraped: ScrapedContent, url: string, env: Env, userId: string): Promise<InsertOutcome> {
	const platformType = detectPlatformType(url);

	const skipContentCheck = platformType === 'youtube' || platformType === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return { error: 'Content too short' };
	}

	try {
		const ogImageUrl = await validateImageUrl(scraped.ogImageUrl);
		return await withDbClient(env, async (db) => {
			const normalizedPlatformMetadata = parsePlatformMetadata(scraped.metadata, platformType);
			const platformMetadataToStore = normalizedPlatformMetadata
				? {
						...normalizedPlatformMetadata,
						ogImageWidth: scraped.ogImageWidth ?? null,
						ogImageHeight: scraped.ogImageHeight ?? null,
					}
				: null;

			const userFile = await insertUrlUserFile(db, {
				url,
				normalizedUrl: url,
				title: scraped.title,
				source: scraped.siteName || 'External',
				publishedDate: scraped.publishedDate || new Date().toISOString(),
				summary: scraped.summary || '',
				platformType,
				content: scraped.content || null,
				ogImageUrl,
				platformMetadata: platformMetadataToStore,
				userId,
			});

			if (!userFile) {
				console.error({ tag: 'INGEST', msg: 'DB insert failed', url, error: 'No id returned' });
				return { error: 'DB insert failed' };
			}

			// ON CONFLICT path: row pre-existed, skip post-insert side effects.
			if (!userFile.created) {
				return { kind: 'page', row: userFile };
			}

			if (scraped.youtubeTranscript) {
				try {
					await upsertYoutubeTranscript(db, scraped.youtubeTranscript);
				} catch (transcriptErr) {
					console.error({
						tag: 'YOUTUBE',
						msg: 'Failed to save transcript',
						videoId: scraped.youtubeTranscript.videoId,
						error: String(transcriptErr),
					});
				}
			}

			console.info({ tag: 'INGEST', msg: 'Saved user_file', title: scraped.title.slice(0, 50), userFileId: userFile.id });
			return { kind: 'page', row: userFile };
		});
	} catch (err) {
		console.error({ tag: 'INGEST', msg: 'DB insert failed', url, error: String(err) });
		return { error: 'DB insert failed' };
	}
}

async function insertScrapedBlob(
	blob: Extract<ScrapeResult, { kind: 'blob' }>,
	url: string,
	env: Env,
	userId: string,
): Promise<InsertOutcome> {
	try {
		const persisted = await persistSavedUrlBlob(env, {
			userId,
			body: blob.body,
			contentLength: blob.contentLength,
			contentType: blob.contentType,
			suggestedFilename: blob.suggestedFilename,
			sourceUrl: blob.sourceUrl,
			normalizedSourceUrl: url,
		});
		if (!persisted.ok) return { error: persisted.message };
		console.info({
			tag: 'INGEST',
			msg: 'Saved blob from URL',
			title: persisted.title.slice(0, 50),
			userFileId: persisted.userFileId,
			contentType: blob.contentType,
		});
		return { kind: 'blob', userFileId: persisted.userFileId, fileType: blob.contentType };
	} finally {
		blob.dispose();
	}
}

async function scrapeAndInsert(url: string, env: Env, userId: string): Promise<InsertOutcome> {
	const result = await scrapeUrl(url, {
		youtubeApiKey: env.YOUTUBE_API_KEY,
		kaitoApiKey: env.KAITO_API_KEY,
	});

	if (result.kind === 'page') {
		return insertScrapedPage(result.scraped, url, env, userId);
	}
	return insertScrapedBlob(result, url, env, userId);
}

function buildUrlResult(url: string, row: UserFileUrlResultRow, args: { instanceId?: string; alreadyExists: boolean }): IngestResult {
	return {
		url,
		userFileId: row.id,
		instanceId: args.instanceId,
		resourceKind: 'url',
		originType: 'saved_url',
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags ?? undefined,
		ogImageUrl: row.og_image_url,
		platformType: row.platform_type || 'web',
		alreadyExists: args.alreadyExists,
	};
}

function isWorkflowComplete(row: ExistingUrlUserFile): boolean {
	return !!row.title_cn && !!row.summary_cn && row.has_embedding;
}

async function returnExisting(url: string, row: ExistingUrlUserFile, env: Env): Promise<IngestResult> {
	if (row.resource_kind === 'blob') {
		const instanceId = isWorkflowComplete(row) ? undefined : await createUserFileWorkflow(env, row.id);
		return {
			url,
			userFileId: row.id,
			instanceId,
			resourceKind: 'blob',
			originType: 'saved_url',
			title: row.title,
			titleCn: row.title_cn || undefined,
			summaryCn: row.summary_cn || undefined,
			tags: row.tags ?? undefined,
			ogImageUrl: row.og_image_url,
			alreadyExists: true,
		};
	}

	const instanceId = isWorkflowComplete(row) ? undefined : await createUserFileWorkflow(env, row.id);
	return buildUrlResult(url, row, { instanceId, alreadyExists: true });
}

async function processUrl(rawUrl: string, env: Env, userId: string): Promise<IngestResult> {
	const url = normalizeUrl(rawUrl);

	const existingRow = await withDbClient(env, (db) => getUrlUserFileByNormalizedSourceUrl(db, userId, url));
	if (existingRow) {
		return returnExisting(url, existingRow, env);
	}

	let result: InsertOutcome;
	try {
		result = await scrapeAndInsert(url, env, userId);
	} catch (err) {
		console.error({ tag: 'INGEST', msg: 'Scrape failed', url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };

	if (result.kind === 'blob') {
		// PDFs run through the AI workflow for text extraction + analysis;
		// images are stored without further processing (no vision pipeline yet).
		const instanceId = result.fileType === PDF_MIME ? await createUserFileWorkflow(env, result.userFileId) : undefined;
		return {
			url,
			userFileId: result.userFileId,
			instanceId,
			resourceKind: 'blob',
			originType: 'saved_url',
			fileType: result.fileType,
			alreadyExists: false,
		};
	}

	const { row } = result;
	// `created=true`: fresh insert, always trigger workflow for AI enrichment.
	// `created=false`: ON CONFLICT race — a concurrent submit already triggered
	//   the workflow on the existing row, skip.
	const instanceId = row.created ? await createUserFileWorkflow(env, row.id) : undefined;
	return buildUrlResult(url, row, { instanceId, alreadyExists: !row.created });
}

export async function ingestUrls(env: Env, args: { urls: string[]; userId?: string }): Promise<IngestUrlsOutcome> {
	if (!args.userId) {
		return { ok: false, code: 'UNAUTHORIZED', message: 'userId is required' };
	}
	if (args.urls.length === 0) {
		return { ok: false, code: 'BAD_REQUEST', message: 'Missing urls field' };
	}
	if (args.urls.length > INGEST_MAX_BATCH_SIZE) {
		return {
			ok: false,
			code: 'BATCH_TOO_LARGE',
			message: `Maximum ${INGEST_MAX_BATCH_SIZE} URLs per request, got ${args.urls.length}`,
		};
	}

	const { success } = await env.USER_INGEST_LIMITER.limit({ key: `user:${args.userId}` });
	if (!success) {
		return { ok: false, code: 'RATE_LIMITED', message: 'Too many ingest requests; retry shortly.' };
	}

	const normalizedUrls = args.urls.map(normalizeUrl);
	const uniqueUrls = [...new Set(normalizedUrls)];

	console.info({ tag: 'INGEST', msg: 'Processing URLs', count: args.urls.length, uniqueCount: uniqueUrls.length, userId: args.userId });
	const userId = args.userId;
	const uniqueResults: IngestResult[] = [];
	for (let i = 0; i < uniqueUrls.length; i += INGEST_URL_CONCURRENCY) {
		const batch = uniqueUrls.slice(i, i + INGEST_URL_CONCURRENCY);
		uniqueResults.push(...(await Promise.all(batch.map((url) => processUrl(url, env, userId)))));
	}
	const resultByUrl = new Map(uniqueResults.map((result) => [result.url, result]));
	const results = normalizedUrls.map((url) => resultByUrl.get(url) ?? { url, error: 'lost during fan-out' });
	return { ok: true, results };
}
