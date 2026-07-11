import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { RESOURCE_ORIGINAL_CONTENT_TYPES, ZH_HANT_RESOURCE_LANG } from '@core-shared/resource-types';
import { withCoreDb } from '@db/client';
import { textArraySql } from '@db/sql';
import { loadResourceForProcessing } from '@ingest/domain/resource-store';
import { upsertResourceTranslation } from '@ingest/domain/resource-translation-store';
import { sql } from 'drizzle-orm';
import { enqueueOrRestartWorkflow } from '../workflow-control';
import {
	assembleZhHantContentTranslation,
	createZhHantContentTranslationChunks,
	DURABLE_CONTENT_TRANSLATION_MAX_CHUNKS,
	generateZhHantMetadataTranslation,
	hasTranslatableContent,
	needsZhHantContentTranslation,
	needsZhHantMetadataTranslation,
	translateZhHantContentChunk,
} from './domain/ai-utils';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';

export async function getPersistedResourceContentHashForLocalization(env: CoreEnv, resourceId: string): Promise<string | null> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			SELECT md5(original.content) AS source_content_hash
			FROM resources resource
			JOIN resource_translations original
			  ON original.resource_id = resource.id
			 AND original.lang = resource.original_lang
			WHERE resource.id = ${resourceId}::uuid
			  AND resource.scope = 'corpus'
			  AND resource.type = ANY(${textArraySql(RESOURCE_ORIGINAL_CONTENT_TYPES)})
			  AND resource.url IS NOT NULL
			  AND resource.original_lang <> 'zh-Hant'
			  AND NULLIF(BTRIM(original.title), '') IS NOT NULL
			  AND NULLIF(BTRIM(original.content), '') IS NOT NULL
			LIMIT 1
		`);
		return (result.rows as Array<{ source_content_hash: string }>)[0]?.source_content_hash ?? null;
	});
}

type MachineTranslationPatch = {
	title?: string;
	summary?: string;
	content?: string;
};

async function persistMachineZhHantTranslation(env: CoreEnv, resourceId: string, patch: MachineTranslationPatch): Promise<void> {
	const persisted = await withCoreDb(env, (db) =>
		upsertResourceTranslation(db, {
			resourceId,
			lang: ZH_HANT_RESOURCE_LANG,
			...patch,
			keywords: [],
			source: 'machine',
		}),
	);
	if (!persisted) throw new Error(`Failed to persist machine translation for resource ${resourceId}`);
}

function persistMachineZhHantContent(env: CoreEnv, resourceId: string, content: string): Promise<void> {
	return persistMachineZhHantTranslation(env, resourceId, { content });
}

async function clearMachineZhHantContent(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, async (db) => {
		await db.execute(sql`
			UPDATE resource_translations
			SET content = NULL, updated_at = NOW()
			WHERE resource_id = ${resourceId}::uuid
			  AND lang = ${ZH_HANT_RESOURCE_LANG}
			  AND source = 'machine'
		`);
	});
}

type ContentLocalizationPayload = { resourceId: string };

const TRANSLATION_STEP_CONCURRENCY = 3;
const CONTENT_LOCALIZATION_WORKFLOW_REVISION = 'v6';

function workflowId(resourceId: string, sourceContentHash: string): string {
	return `content-localization-${CONTENT_LOCALIZATION_WORKFLOW_REVISION}-${sourceContentHash.slice(0, 12)}-${resourceId}`;
}

export function enqueueContentLocalization(env: CoreEnv, resourceId: string, sourceContentHash: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.CONTENT_LOCALIZATION_WORKFLOW, workflowId(resourceId, sourceContentHash), {
		resourceId,
	});
}

async function translateZhHantContentDurably(env: CoreEnv, step: WorkflowStep, source: string): Promise<string> {
	const chunks = createZhHantContentTranslationChunks(source, DURABLE_CONTENT_TRANSLATION_MAX_CHUNKS);
	const translatedChunks: string[] = [];
	for (let offset = 0; offset < chunks.length; offset += TRANSLATION_STEP_CONCURRENCY) {
		const batch = chunks.slice(offset, offset + TRANSLATION_STEP_CONCURRENCY);
		const translations = await Promise.all(
			batch.map((chunk, batchIndex) => {
				const index = offset + batchIndex;
				return step.do(
					`translate-zh-hant-content-${index + 1}-of-${chunks.length}`,
					{
						retries: {
							limit: 3,
							delay: '15 seconds',
							backoff: 'exponential',
						},
						timeout: '180 seconds',
					},
					() => translateZhHantContentChunk(chunk, index, chunks.length, env),
				);
			}),
		);
		translatedChunks.push(...translations);
	}
	return assembleZhHantContentTranslation(source, translatedChunks);
}

export class ContentLocalizationWorkflow extends WorkflowEntrypoint<CoreEnv, ContentLocalizationPayload> {
	async run(event: WorkflowEvent<ContentLocalizationPayload>, step: WorkflowStep) {
		return this.localizeResource(event.payload.resourceId, step);
	}

	private async localizeResource(resourceId: string, step: WorkflowStep) {
		const initial = await step.do(
			'load-content-localization-resource',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			async () => loadResourceForProcessing(this.env, resourceId),
		);

		let resource = initial;
		const initialContent = initial.content?.trim();
		if (!initialContent) throw new Error(`Resource ${resourceId} has no persisted original content`);

		const zhHantTranslation = resource.translations?.[ZH_HANT_RESOURCE_LANG];
		const zhHantContent = zhHantTranslation?.source === 'human' ? null : zhHantTranslation?.content?.trim();
		if (resource.content && !hasTranslatableContent(resource.content) && zhHantContent) {
			resource = {
				...resource,
				translations: {
					...resource.translations,
					[ZH_HANT_RESOURCE_LANG]: { ...zhHantTranslation, content: null },
				},
			};
			await step.do(
				'clear-nontext-zh-hant-content',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => clearMachineZhHantContent(this.env, resourceId),
			);
		} else if (zhHantContent) {
			const sanitizedContent = sanitizeExtractedMarkdown(zhHantContent);
			if (sanitizedContent !== zhHantContent) {
				resource = {
					...resource,
					translations: {
						...resource.translations,
						[ZH_HANT_RESOURCE_LANG]: { ...zhHantTranslation, content: sanitizedContent || null },
					},
				};
				await step.do(
					'persist-sanitized-zh-hant-content',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => persistMachineZhHantContent(this.env, resourceId, sanitizedContent),
				);
			}
		}

		if (needsZhHantMetadataTranslation(resource)) {
			const translatedMetadata = await step.do(
				'localize-zh-hant-title-summary',
				{
					retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
					timeout: '180 seconds',
				},
				() => generateZhHantMetadataTranslation(resource, this.env),
			);
			await step.do(
				'persist-zh-hant-title-summary',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistMachineZhHantTranslation(this.env, resourceId, translatedMetadata),
			);
			resource = {
				...resource,
				translations: {
					...resource.translations,
					[ZH_HANT_RESOURCE_LANG]: {
						...resource.translations?.[ZH_HANT_RESOURCE_LANG],
						...translatedMetadata,
						source: 'machine',
					},
				},
			};
		}

		if (needsZhHantContentTranslation(resource)) {
			const source = resource.content!.trim();
			const translated = await translateZhHantContentDurably(this.env, step, source);
			await step.do(
				'persist-zh-hant-content',
				{
					retries: {
						limit: 3,
						delay: '5 seconds',
						backoff: 'exponential',
					},
					timeout: '30 seconds',
				},
				() => persistMachineZhHantContent(this.env, resourceId, translated),
			);
		}
		console.info({
			tag: 'CONTENT_LOCALIZATION',
			msg: 'Completed',
			resource_id: resourceId,
		});
		return { success: true, resource_id: resourceId };
	}
}
