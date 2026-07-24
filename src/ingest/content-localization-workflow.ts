import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { RESOURCE_ORIGINAL_CONTENT_TYPES, ZH_HANT_RESOURCE_LANG } from '@core-shared/resource-types';
import { withCoreDb } from '@db/client';
import { textArraySql } from '@db/sql';
import { loadResourceForProcessing, upsertResourceTranslation } from '@ingest/domain/resource-store';
import { sql } from 'drizzle-orm';
import { syncCorpusItem } from '../ai-search';
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

export async function getPersistedResourceTranslationHash(env: CoreEnv, resourceId: string): Promise<string | null> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute<{ source_translation_hash: string }>(sql`
			SELECT md5(jsonb_build_array(original.title, original.summary, original.content)::text) AS source_translation_hash
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
		return result.rows[0]?.source_translation_hash ?? null;
	});
}

type MachineTranslationPatch = {
	title?: string;
	summary?: string;
	content?: string;
};

class ResourceTranslationSourceChangedError extends NonRetryableError {
	constructor(resourceId: string) {
		super(`Original translation source changed while translating resource ${resourceId}`, 'ResourceTranslationSourceChangedError');
	}
}

async function persistMachineZhHantTranslation(
	env: CoreEnv,
	resourceId: string,
	sourceTranslationHash: string,
	patch: MachineTranslationPatch,
): Promise<void> {
	const persisted = await withCoreDb(env, (db) =>
		upsertResourceTranslation(db, {
			resourceId,
			lang: ZH_HANT_RESOURCE_LANG,
			...patch,
			keywords: [],
			source: 'machine',
			expectedOriginalTranslationHash: sourceTranslationHash,
		}),
	);
	if (!persisted) throw new ResourceTranslationSourceChangedError(resourceId);
}

function persistMachineZhHantContent(env: CoreEnv, resourceId: string, sourceTranslationHash: string, content: string): Promise<void> {
	return persistMachineZhHantTranslation(env, resourceId, sourceTranslationHash, { content });
}

async function clearMachineZhHantContent(env: CoreEnv, resourceId: string, sourceTranslationHash: string): Promise<void> {
	const sourceIsCurrent = await withCoreDb(env, async (db) => {
		const result = await db.execute<{ source_is_current: boolean }>(sql`
			WITH target_resource AS (
				SELECT resource.id
				FROM resources resource
				JOIN resource_translations original
				  ON original.resource_id = resource.id
				 AND original.lang = resource.original_lang
				WHERE resource.id = ${resourceId}::uuid
				  AND md5(jsonb_build_array(original.title, original.summary, original.content)::text) = ${sourceTranslationHash}
				FOR SHARE OF original
			), cleared AS (
				UPDATE resource_translations translation
				SET content = NULL, updated_at = NOW()
				FROM target_resource
				WHERE translation.resource_id = target_resource.id
				  AND translation.lang = ${ZH_HANT_RESOURCE_LANG}
				  AND translation.source = 'machine'
				RETURNING translation.resource_id
			)
			SELECT EXISTS (SELECT 1 FROM target_resource) AS source_is_current
		`);
		return result.rows[0]?.source_is_current ?? false;
	});
	if (!sourceIsCurrent) throw new ResourceTranslationSourceChangedError(resourceId);
}

type ResourceTranslationPayload = { resourceId: string; sourceTranslationHash: string };

const TRANSLATION_STEP_CONCURRENCY = 3;
const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'v12';

function workflowId(resourceId: string, sourceTranslationHash: string): string {
	return `resource-translation-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${sourceTranslationHash.slice(0, 12)}-${resourceId}`;
}

export function enqueueResourceTranslation(env: CoreEnv, resourceId: string, sourceTranslationHash: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_TRANSLATION_WORKFLOW, workflowId(resourceId, sourceTranslationHash), {
		resourceId,
		sourceTranslationHash,
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

export class ResourceTranslationWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(event: WorkflowEvent<ResourceTranslationPayload>, step: WorkflowStep) {
		return this.translateResource(event.payload.resourceId, event.payload.sourceTranslationHash, step);
	}

	private async translateResource(resourceId: string, sourceTranslationHash: string, step: WorkflowStep) {
		const [initial, currentSourceTranslationHash] = await step.do(
			'load-resource-translation-input',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			() => Promise.all([loadResourceForProcessing(this.env, resourceId), getPersistedResourceTranslationHash(this.env, resourceId)]),
		);
		if (currentSourceTranslationHash !== sourceTranslationHash) throw new ResourceTranslationSourceChangedError(resourceId);

		let resource = initial;
		const initialContent = initial.content?.trim();
		if (!initialContent) throw new Error(`Resource ${resourceId} has no persisted original content`);

		const zhHantTranslation = resource.translations[ZH_HANT_RESOURCE_LANG];
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
				() => clearMachineZhHantContent(this.env, resourceId, sourceTranslationHash),
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
					() => persistMachineZhHantContent(this.env, resourceId, sourceTranslationHash, sanitizedContent),
				);
			}
		}

		if (needsZhHantMetadataTranslation(resource)) {
			const translatedMetadata = await step.do(
				'translate-zh-hant-title-summary',
				{
					retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
					timeout: '180 seconds',
				},
				() => generateZhHantMetadataTranslation(resource, this.env),
			);
			await step.do(
				'persist-zh-hant-title-summary',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistMachineZhHantTranslation(this.env, resourceId, sourceTranslationHash, translatedMetadata),
			);
			resource = {
				...resource,
				translations: {
					...resource.translations,
					[ZH_HANT_RESOURCE_LANG]: {
						...resource.translations[ZH_HANT_RESOURCE_LANG],
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
				() => persistMachineZhHantContent(this.env, resourceId, sourceTranslationHash, translated),
			);
		}
		await step.do(
			'sync-translated-resource-to-ai-search',
			{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			() => syncCorpusItem(this.env, resourceId),
		);
		console.info({
			tag: 'RESOURCE_TRANSLATION',
			msg: 'Completed',
			resource_id: resourceId,
		});
		return { success: true, resource_id: resourceId };
	}
}
