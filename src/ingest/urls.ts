import { USER_FILES_TABLE } from '@core-shared/article-store';
import { PDF_MIME } from '@core-shared/mime';
import type { ScrapedContent } from '@core-shared/types';
import { detectUrlKind, normalizeUrl } from '@core-shared/web';
import { upsertYoutubeTranscript } from '@ingest/platforms/youtube/transcripts';
import { createUserFileWorkflow } from '@ingest/workflows/queue';
import { Client } from 'pg';
import { persistSavedUrlBlob } from './blob';
import { type ScrapeResult, scrapeUrl } from './platforms/registry';

const INGEST_MAX_BATCH_SIZE = 20;
const INGEST_URL_CONCURRENCY = 4;
const EXISTING_URL_USER_FILE_FIELDS =
	'id, title, title_cn, summary_cn, tags, platform_type, og_image_url, resource_kind, embedding IS NOT NULL AS has_embedding';

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

type InsertUrlUserFileResult = {
	id: string;
	created: boolean;
	title: string;
	title_cn: string | null;
	summary_cn: string | null;
	tags: string[];
	platform_type: string | null;
	og_image_url: string | null;
};

type ExistingUrlUserFile = {
	id: string;
	title: string;
	title_cn: string | null;
	summary_cn: string | null;
	tags: string[] | null;
	platform_type: string | null;
	og_image_url: string | null;
	resource_kind: string;
	has_embedding: boolean;
};

type InsertOutcome =
	| { kind: 'page'; row: InsertUrlUserFileResult }
	| { kind: 'blob'; userFileId: string; fileType: string }
	| { error: string };

type UserFileUrlResultRow = Pick<
	ExistingUrlUserFile,
	'id' | 'title' | 'title_cn' | 'summary_cn' | 'tags' | 'platform_type' | 'og_image_url'
>;

async function insertScrapedPage(db: Client, scraped: ScrapedContent, url: string, userId: string): Promise<InsertOutcome> {
	const urlKind = detectUrlKind(url);

	const skipContentCheck = urlKind === 'youtube' || urlKind === 'twitter';
	if (!skipContentCheck && (!scraped.content || scraped.content.length < 50)) {
		return { error: 'Content too short' };
	}

	try {
		const inserted = await db.query(
			`WITH inserted AS (
				INSERT INTO ${USER_FILES_TABLE}
				(file_name, file_type, resource_kind, origin_type, platform_type, source_url, normalized_source_url, title, site_name, published_date,
				 summary, extracted_text, og_image_url, keywords, tags, metadata,
				 user_id)
				VALUES ($1, $2, 'url', 'saved_url', $2, $3, $3, $1, $4, $5, $6, $7, NULL, $8, $9, $10, $11)
				ON CONFLICT (user_id, normalized_source_url)
				WHERE resource_kind = 'url' AND normalized_source_url IS NOT NULL
				DO NOTHING
				RETURNING id, title, title_cn, summary_cn, tags, platform_type, og_image_url, TRUE AS created
			)
			SELECT id, title, title_cn, summary_cn, tags, platform_type, og_image_url, created FROM inserted
			UNION ALL
			SELECT id, title, title_cn, summary_cn, tags, platform_type, og_image_url, FALSE AS created
			FROM ${USER_FILES_TABLE}
			WHERE user_id = $11
			  AND normalized_source_url = $3
			  AND resource_kind = 'url'
			  AND NOT EXISTS (SELECT 1 FROM inserted)
			LIMIT 1`,
			[
				scraped.title,
				urlKind,
				url,
				scraped.siteName || 'External',
				scraped.publishedDate || new Date().toISOString(),
				scraped.summary || '',
				scraped.content || null,
				[],
				[],
				scraped.metadata == null ? null : JSON.stringify(scraped.metadata),
				userId,
			],
		);
		const userFile = inserted.rows[0] as InsertUrlUserFileResult | undefined;

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

async function returnExisting(db: Client, url: string, row: ExistingUrlUserFile, env: Env): Promise<IngestResult> {
	if (row.resource_kind === 'blob') {
		const instanceId = row.title_cn && row.summary_cn && row.has_embedding ? undefined : await createUserFileWorkflow(env, row.id, db);
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

	const instanceId = row.title_cn && row.summary_cn && row.has_embedding ? undefined : await createUserFileWorkflow(env, row.id, db);
	return buildUrlResult(url, row, { instanceId, alreadyExists: true });
}

async function processUrl(db: Client, url: string, env: Env, userId: string): Promise<IngestResult> {
	const existing = await db.query<ExistingUrlUserFile>(
		`SELECT ${EXISTING_URL_USER_FILE_FIELDS} FROM ${USER_FILES_TABLE}
		 WHERE user_id = $1
		   AND normalized_source_url = $2
		 LIMIT 1`,
		[userId, url],
	);
	const existingRow = existing.rows[0] ?? null;
	if (existingRow) {
		return returnExisting(db, url, existingRow, env);
	}

	let result: InsertOutcome;
	try {
		const scrapeResult = await scrapeUrl(url, {
			youtubeApiKey: env.YOUTUBE_API_KEY,
			kaitoApiKey: env.KAITO_API_KEY,
		});
		result =
			scrapeResult.kind === 'page'
				? await insertScrapedPage(db, scrapeResult.scraped, url, userId)
				: await insertScrapedBlob(scrapeResult, url, env, userId);
	} catch (err) {
		console.error({ tag: 'INGEST', msg: 'Scrape failed', url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };

	if (result.kind === 'blob') {
		// PDFs run through the AI workflow for text extraction + analysis;
		// images are stored without further processing (no vision pipeline yet).
		const instanceId = result.fileType === PDF_MIME ? await createUserFileWorkflow(env, result.userFileId, db) : undefined;
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
	const instanceId = row.created ? await createUserFileWorkflow(env, row.id, db) : undefined;
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
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	const uniqueResults: IngestResult[] = [];
	for (let i = 0; i < uniqueUrls.length; i += INGEST_URL_CONCURRENCY) {
		const batch = uniqueUrls.slice(i, i + INGEST_URL_CONCURRENCY);
		uniqueResults.push(...(await Promise.all(batch.map((url) => processUrl(db, url, env, userId)))));
	}
	const resultByUrl = new Map(uniqueResults.map((result) => [result.url, result]));
	const results = normalizedUrls.map((url) => resultByUrl.get(url) ?? { url, error: 'lost during fan-out' });
	return { ok: true, results };
}
