import type { WorkflowAttachment } from '@core-shared/types';
import { normalizeUrl } from '@core-shared/web';
import { type InsertUrlUserFileResult, insertScrapedUrlUserFile } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import { Client } from 'pg';
import { type ScrapeResult, scrapeUrl } from './extract';

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
	blob?: Extract<ScrapeResult, { kind: 'blob' }>;
	alreadyExists?: boolean;
	error?: string;
};

type IngestErrorCode = 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED';
export type IngestUrlsOutcome = { ok: true; results: IngestResult[] } | { ok: false; code: IngestErrorCode; message: string };

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
	| { kind: 'page'; row: InsertUrlUserFileResult; attachments?: WorkflowAttachment[] }
	| { kind: 'blob'; blob: Extract<ScrapeResult, { kind: 'blob' }> }
	| { error: string };

type UserFileUrlResultRow = Pick<
	ExistingUrlUserFile,
	'id' | 'title' | 'title_cn' | 'summary_cn' | 'tags' | 'platform_type' | 'og_image_url'
>;

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
	const instanceId =
		row.title_cn && row.summary_cn && row.has_embedding
			? undefined
			: await enqueueProcessing(env, { kind: 'userFile', userFileId: row.id }, { db });
	if (row.resource_kind === 'blob') {
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

	return buildUrlResult(url, row, { instanceId, alreadyExists: true });
}

async function processUrl(db: Client, url: string, env: Env, userId: string): Promise<IngestResult> {
	const existing = await db.query<ExistingUrlUserFile>(
		`SELECT ${EXISTING_URL_USER_FILE_FIELDS} FROM user_files
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
		if (scrapeResult.kind === 'page') {
			const inserted = await insertScrapedUrlUserFile(db, scrapeResult.scraped, url, userId);
			const attachments: WorkflowAttachment[] | undefined = scrapeResult.scraped.youtubeTranscript
				? [{ kind: 'youtube-transcript', transcript: scrapeResult.scraped.youtubeTranscript }]
				: undefined;
			result = inserted.ok ? { kind: 'page', row: inserted.row, ...(attachments ? { attachments } : {}) } : { error: inserted.error };
		} else {
			result = { kind: 'blob', blob: scrapeResult };
		}
	} catch (err) {
		console.error({ tag: 'INGEST', msg: 'Scrape failed', url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}
	if ('error' in result) return { url, error: result.error };

	if (result.kind === 'blob') {
		return {
			url,
			resourceKind: 'blob',
			originType: 'saved_url',
			fileType: result.blob.contentType,
			blob: result.blob,
			alreadyExists: false,
		};
	}

	const { row } = result;
	const instanceId = row.created
		? await enqueueProcessing(
				env,
				{ kind: 'userFile', userFileId: row.id, ...(result.attachments ? { attachments: result.attachments } : {}) },
				{ db },
			)
		: undefined;
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

	const normalizedUrls = args.urls.map(normalizeUrl);
	const uniqueUrls = [...new Set(normalizedUrls)];

	console.info({ tag: 'INGEST', msg: 'Processing URLs', count: args.urls.length, uniqueCount: uniqueUrls.length, userId: args.userId });
	const userId = args.userId;
	const db = new Client({ connectionString: env.HYPERDRIVE.connectionString });
	await db.connect();
	try {
		const uniqueResults: IngestResult[] = [];
		for (let i = 0; i < uniqueUrls.length; i += INGEST_URL_CONCURRENCY) {
			const batch = uniqueUrls.slice(i, i + INGEST_URL_CONCURRENCY);
			uniqueResults.push(...(await Promise.all(batch.map((url) => processUrl(db, url, env, userId)))));
		}
		const resultByUrl = new Map(uniqueResults.map((result) => [result.url, result]));
		const results = normalizedUrls.map((url) => resultByUrl.get(url) ?? { url, error: 'lost during fan-out' });
		return { ok: true, results };
	} finally {
		await db.end();
	}
}
