import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { ZH_HANT_RESOURCE_LANG } from '@core-shared/resource-types';
import { type CoreDb, withCoreDb, withCoreTx } from '@db/client';
import { resources, resourceTranslations } from '@db/schema';
import {
	isResourceTranslationRevision,
	loadResourceForProcessingFromDb,
	resourceTranslationIdentityPredicate,
	resourceTranslationRevisionSql,
	upsertResourceTranslation,
} from '@ingest/domain/resource-store';
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

async function loadEligibleResourceTranslationRevisionFromDb(db: CoreDb, resourceId: string): Promise<string | null> {
	const result = await db.execute<{ source_revision: string }>(sql`
			SELECT ${resourceTranslationRevisionSql({
				content: sql`original.content`,
				lang: sql`original.lang`,
				summary: sql`original.summary`,
				title: sql`original.title`,
			})} AS source_revision
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
	return result.rows[0]?.source_revision ?? null;
}

export function loadEligibleResourceTranslationRevision(env: CoreEnv, resourceId: string): Promise<string | null> {
	return withCoreDb(env, (db) => loadEligibleResourceTranslationRevisionFromDb(db, resourceId));
}

async function loadEligibleResourceTranslationInput(env: CoreEnv, resourceId: string) {
	return withCoreTx(env, async (db, client) => {
		await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
		const sourceRevision = await loadEligibleResourceTranslationRevisionFromDb(db, resourceId);
		if (!sourceRevision) return null;
		const resource = await loadResourceForProcessingFromDb(db, resourceId);
		return { resource, sourceRevision };
	});
}

type MachineTranslationPatch = {
	title?: string;
	summary?: string;
	content?: string;
};

async function persistMachineZhHantTranslation(
	env: CoreEnv,
	resourceId: string,
	sourceRevision: string,
	patch: MachineTranslationPatch,
): Promise<boolean> {
	return withCoreDb(env, (db) =>
		upsertResourceTranslation(db, {
			resourceId,
			lang: ZH_HANT_RESOURCE_LANG,
			...patch,
			keywords: [],
			source: 'machine',
			expectedOriginalRevision: sourceRevision,
		}),
	);
}

function persistMachineZhHantContent(env: CoreEnv, resourceId: string, sourceRevision: string, content: string): Promise<boolean> {
	return persistMachineZhHantTranslation(env, resourceId, sourceRevision, { content });
}

async function clearMachineZhHantContent(env: CoreEnv, resourceId: string, sourceRevision: string): Promise<boolean> {
	return withCoreDb(env, async (db) => {
		const result = await db.execute(sql`
			WITH current_source AS (
				SELECT resource.id
				FROM resources resource
				JOIN resource_translations original
				  ON original.resource_id = resource.id
				 AND original.lang = resource.original_lang
				WHERE resource.id = ${resourceId}::uuid
				  AND ${resourceTranslationRevisionSql({
						content: sql`original.content`,
						lang: sql`original.lang`,
						summary: sql`original.summary`,
						title: sql`original.title`,
					})} = ${sourceRevision}
				FOR UPDATE OF resource
			)
			UPDATE resource_translations translation
			SET content = NULL, updated_at = NOW()
			FROM current_source
			WHERE translation.resource_id = current_source.id
			  AND translation.lang = ${ZH_HANT_RESOURCE_LANG}
			  AND translation.source = 'machine'
			RETURNING translation.resource_id
		`);
		return result.rows.length > 0;
	});
}

type ResourceTranslationPayload = { resourceId: string; sourceRevision: string };

const RESOURCE_TRANSLATION_WORKFLOW_REVISION = 'canonical-v3';

function workflowId(resourceId: string, sourceRevision: string): string {
	return `rt-${RESOURCE_TRANSLATION_WORKFLOW_REVISION}-${resourceId}-${sourceRevision}`;
}

// One stable instance per source revision dedupes repeated enqueue attempts while
// ensuring a newer original body never shares execution with an older one.
export async function enqueueResourceTranslation(env: CoreEnv, resourceId: string, sourceRevision: string): Promise<string> {
	if (!isResourceTranslationRevision(sourceRevision)) throw new Error('Invalid resource translation source revision');
	return enqueueOrRestartWorkflow(env.RESOURCE_TRANSLATION_V2_WORKFLOW, workflowId(resourceId, sourceRevision), {
		resourceId,
		sourceRevision,
	});
}

export class ResourceTranslationV2Workflow extends WorkflowEntrypoint<CoreEnv, ResourceTranslationPayload> {
	async run(event: WorkflowEvent<ResourceTranslationPayload>, step: WorkflowStep) {
		return this.translateResource(event.payload.resourceId, event.payload.sourceRevision, step);
	}

	private async translateResource(resourceId: string, sourceRevision: string, step: WorkflowStep) {
		if (!isResourceTranslationRevision(sourceRevision)) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Legacy source revision missing; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true, superseded: true };
		}
		const input = await step.do(
			'load-resource-translation-input-kind-platform-v1',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			() => loadEligibleResourceTranslationInput(this.env, resourceId),
		);
		if (!input) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'No longer eligible; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true };
		}
		if (input.sourceRevision !== sourceRevision) {
			console.info({ tag: 'RESOURCE_TRANSLATION', msg: 'Source revision was superseded; skipping', resource_id: resourceId });
			return { success: true, resource_id: resourceId, skipped: true, superseded: true };
		}

		let resource = input.resource;
		const initialContent = resource.content?.trim();
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
			const persisted = await step.do(
				'clear-nontext-zh-hant-content',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => clearMachineZhHantContent(this.env, resourceId, sourceRevision),
			);
			if (!persisted) return { success: true, resource_id: resourceId, skipped: true, superseded: true };
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
				const persisted = await step.do(
					'persist-sanitized-zh-hant-content',
					{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
					() => persistMachineZhHantContent(this.env, resourceId, sourceRevision, sanitizedContent),
				);
				if (!persisted) return { success: true, resource_id: resourceId, skipped: true, superseded: true };
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
			const persisted = await step.do(
				'persist-zh-hant-title-summary',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => persistMachineZhHantTranslation(this.env, resourceId, sourceRevision, translatedMetadata),
			);
			if (!persisted) return { success: true, resource_id: resourceId, skipped: true, superseded: true };
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
				() => translateZhHantContent(source, this.env, resourceId),
			);
			const persisted = await step.do(
				'persist-zh-hant-content',
				{
					retries: {
						limit: 3,
						delay: '5 seconds',
						backoff: 'exponential',
					},
					timeout: '30 seconds',
				},
				() => persistMachineZhHantContent(this.env, resourceId, sourceRevision, translated),
			);
			if (!persisted) return { success: true, resource_id: resourceId, skipped: true, superseded: true };
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
