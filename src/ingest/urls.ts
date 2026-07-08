import { normalizeUrl } from '@core-shared/web';
import { getExistingUrlUserFile, insertScrapedUrlUserFile } from '@ingest/domain/article-store';
import { enqueueProcessing } from '@ingest/workflow';
import { Client } from 'pg';
import { type ScrapeResult, scrapeUrl } from './extract';

const INGEST_MAX_BATCH_SIZE = 20;
const INGEST_URL_CONCURRENCY = 4;

type ExistingUrlUserFile = NonNullable<Awaited<ReturnType<typeof getExistingUrlUserFile>>>;

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
	asset?: Extract<ScrapeResult, { kind: 'asset' }>;
	alreadyExists?: boolean;
	error?: string;
};

function buildUserFileResult(
	url: string,
	row: {
		id: string;
		title: string;
		title_cn: string | null;
		summary_cn: string | null;
		tags: string[] | null;
		platform_type: string | null;
		og_image_url: string | null;
	},
	args: { instanceId?: string; alreadyExists: boolean; resourceKind?: 'url' | 'blob' },
): IngestResult {
	const resourceKind = args.resourceKind ?? 'url';
	const result: IngestResult = {
		url,
		userFileId: row.id,
		instanceId: args.instanceId,
		resourceKind,
		originType: 'saved_url',
		title: row.title,
		titleCn: row.title_cn || undefined,
		summaryCn: row.summary_cn || undefined,
		tags: row.tags ?? undefined,
		ogImageUrl: row.og_image_url,
		alreadyExists: args.alreadyExists,
	};
	if (resourceKind === 'url') result.platformType = row.platform_type || 'web';
	return result;
}

async function returnExisting(db: Client, url: string, row: ExistingUrlUserFile, env: Env): Promise<IngestResult> {
	const instanceId =
		row.title_cn && row.summary_cn && row.has_embedding
			? undefined
			: await enqueueProcessing(env, { kind: 'userFile', userFileId: row.id }, { db });
	return buildUserFileResult(url, row, { instanceId, alreadyExists: true, resourceKind: row.resource_kind === 'blob' ? 'blob' : 'url' });
}

async function processUrl(db: Client, url: string, env: Env, userId: string): Promise<IngestResult> {
	const existingRow = await getExistingUrlUserFile(db, userId, url);
	if (existingRow) {
		return returnExisting(db, url, existingRow, env);
	}

	let scrapeResult: ScrapeResult;
	try {
		scrapeResult = await scrapeUrl(url, {
			youtubeApiKey: env.YOUTUBE_API_KEY,
			kaitoApiKey: env.KAITO_API_KEY,
		});
	} catch (err) {
		console.error({ tag: 'INGEST', msg: 'Scrape failed', url, error: String(err) });
		return { url, error: `Scrape failed: ${err}` };
	}

	if (scrapeResult.kind === 'asset') {
		return {
			url,
			resourceKind: 'blob',
			originType: 'saved_url',
			fileType: scrapeResult.contentType,
			asset: scrapeResult,
			alreadyExists: false,
		};
	}

	const inserted = await insertScrapedUrlUserFile(db, scrapeResult.scraped, url, userId);
	if (!inserted.ok) return { url, error: inserted.error };

	const { row } = inserted;
	const instanceId = row.created
		? await enqueueProcessing(
				env,
				{
					kind: 'userFile',
					userFileId: row.id,
					attachments: scrapeResult.scraped.attachments,
				},
				{ db },
			)
		: undefined;
	return buildUserFileResult(url, row, { instanceId, alreadyExists: !row.created });
}

export async function ingestUrls(
	env: Env,
	args: { urls: string[]; userId?: string },
): Promise<
	| { ok: true; results: IngestResult[] }
	| { ok: false; code: 'BATCH_TOO_LARGE' | 'RATE_LIMITED' | 'BAD_REQUEST' | 'UNAUTHORIZED'; message: string }
> {
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
