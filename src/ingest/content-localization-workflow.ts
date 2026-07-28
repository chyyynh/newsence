import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { ZH_HANT_RESOURCE_LANG } from '@core-shared/resource-types';
import { withCoreDb } from '@db/client';
import { resources, resourceTranslations } from '@db/schema';
import { loadResourceForProcessing, resourceTranslationIdentityPredicate, upsertResourceTranslation } from '@ingest/domain/resource-store';
import { sql } from 'drizzle-orm';
import { syncCorpusItem } from '../ai-search';
import { enqueueOrRestartWorkflow } from '../workflow-control';
import {
	CONTENT_TRANSLATION_MAX_LENGTH,
	generateZhHantMetadataTranslation,
	hasTranslatableContent,
	needsZhHantContentTranslation,
	needsZhHantMetadataTranslation,
	translateZhHantContent,
} from './domain/ai-utils';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';

export async function isResourceTranslationEligible(env: CoreEnv, resourceId: string): Promise<boolean> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			SELECT 1
			FROM ${resources}
			JOIN ${resourceTranslations} original
			  ON original.resource_id = ${resources.id}
			 AND original.lang = ${resources.originalLang}
			WHERE ${resources.id} = ${resourceId}::uuid
			  AND ${resources.scope} = 'corpus'
			  AND ${resourceTranslationIdentityPredicate()}
			  AND ${resources.url} IS NOT NULL
			  AND ${resources.originalLang} <> 'zh-Hant'
			  AND NULLIF(BTRIM(original.title), '') IS NOT NULL
			  AND NULLIF(BTRIM(original.content), '') IS NOT NULL
			  -- Length gate lives here as well as in needsZhHantContentTranslation:
			  -- loading a multi-megabyte body blows the 1MiB step-output limit
			  -- before any in-workflow check can run.
			  AND length(original.content) <= ${CONTENT_TRANSLATION_MAX_LENGTH}
			LIMIT 1
		`);
		return result.rows.length > 0;
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
	// The only way the upsert matches no resource is a row deleted mid-translation.
	if (!persisted) throw new NonRetryableError(`Resource ${resourceId} disappeared while translating`, 'ResourceGoneError');
}

function persistMachineZhHantContent(env: CoreEnv, resourceId: string, content: string): Promise<void> {
	return persistMachineZhHantTranslation(env, resourceId, { content });
}

async function clearMachineZhHantContent(env: CoreEnv, resourceId: string): Promise<void> {
	await withCoreDb(env, (db) =>
		db.execute(sql`
			UPDATE resource_translations
			SET content = NULL, updated_at = NOW()
			WHERE resource_id = ${resourceId}::uuid
			  AND lang = ${ZH_HANT_RESOURCE_LANG}
			  AND source = 'machine'
		`),
	);
}

type ResourceTranslationPayload = { resourceId: string };

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'v16';

function workflowId(resourceId: string): string {
	return `resource-translation-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}`;
}

// One stable instance per resource: enqueueOrRestartWorkflow leaves a running
// instance alone and restarts a finished one, which is what re-processing wants.
export function enqueueResourceTranslation(env: CoreEnv, resourceId: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.RESOURCE_TRANSLATION_WORKFLOW, workflowId(resourceId), { resourceId });
}

export class ResourceTranslationWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(event: WorkflowEvent<ResourceTranslationPayload>, step: WorkflowStep) {
		return this.translateResource(event.payload.resourceId, step);
	}

	private async translateResource(resourceId: string, step: WorkflowStep) {
		const [initial, eligible] = await step.do(
			'load-resource-translation-input-kind-platform-v1',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			() => Promise.all([loadResourceForProcessing(this.env, resourceId), isResourceTranslationEligible(this.env, resourceId)]),
		);
		if (!eligible) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'No longer eligible; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true };
		}

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
				() => persistMachineZhHantTranslation(this.env, resourceId, translatedMetadata),
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
			const translated = await step.do(
				'translate-zh-hant-content',
				// A body at the 36k-character ceiling emits ~11.1k tokens at a
				// measured ~90 tokens/s, so 180s left almost no margin.
				{ retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				() => translateZhHantContent(source, this.env),
			);
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
