import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
	ContentLocalizationSourceChangedError,
	claimContentLocalizationWork,
	clearMachineZhHantContent,
	exhaustContentLocalizationAttempts,
	markContentLocalizationComplete,
	markContentLocalizationFailed,
	markContentLocalizationRunning,
	persistBackfilledZhHantContent,
	persistMachineZhHantTranslation,
} from '@ingest/domain/content-localization-store';
import { loadResourceForProcessing } from '@ingest/domain/resource-store';
import { ZH_HANT_RESOURCE_LANG } from '../resources/types';
import {
	assembleZhHantContentTranslation,
	ContentTranslationLimitError,
	createZhHantContentTranslationChunks,
	DURABLE_CONTENT_TRANSLATION_MAX_CHUNKS,
	generateZhHantMetadataTranslation,
	hasTranslatableContent,
	needsZhHantContentTranslation,
	needsZhHantMetadataTranslation,
	translateZhHantContentChunk,
} from './domain/ai-utils';
import { sanitizeExtractedMarkdown } from './domain/content-sanitization';

type ContentLocalizationPayload = { resourceId: string; sourceContentHash: string };

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);
const TRANSLATION_STEP_CONCURRENCY = 3;
const CONTENT_LOCALIZATION_WORKFLOW_REVISION = 'v5';

function workflowId(resourceId: string, sourceContentHash: string): string {
	return `content-localization-${CONTENT_LOCALIZATION_WORKFLOW_REVISION}-${sourceContentHash.slice(0, 12)}-${resourceId}`;
}

async function restartWorkflowIfInactive(workflow: Workflow, id: string): Promise<string> {
	const instance = await workflow.get(id);
	const { status } = await instance.status();
	if (!ACTIVE_WORKFLOW_STATUSES.has(status)) await instance.restart();
	return instance.id;
}

export async function enqueueOrRestartWorkflow<Params>(workflow: Workflow<Params>, id: string, params: Params): Promise<string> {
	const [created] = await workflow.createBatch([{ id, params }]);
	return created ? created.id : restartWorkflowIfInactive(workflow, id);
}

export function enqueueContentLocalization(env: CoreEnv, resourceId: string, sourceContentHash: string): Promise<string> {
	return enqueueOrRestartWorkflow(env.CONTENT_LOCALIZATION_WORKFLOW, workflowId(resourceId, sourceContentHash), {
		resourceId,
		sourceContentHash,
	});
}

async function markClaimsFailed(
	env: CoreEnv,
	claims: Array<{ resourceId: string; sourceContentHash: string }>,
	error: unknown,
): Promise<void> {
	await Promise.allSettled(
		claims.map(({ resourceId, sourceContentHash }) => markContentLocalizationFailed(env, resourceId, sourceContentHash, error)),
	);
}

export async function scheduleContentLocalization(env: CoreEnv): Promise<void> {
	const claims = await claimContentLocalizationWork(env);
	if (!claims.length) return;

	const created = await env.CONTENT_LOCALIZATION_WORKFLOW.createBatch(
		claims.map(({ resourceId, sourceContentHash }) => ({
			id: workflowId(resourceId, sourceContentHash),
			params: { resourceId, sourceContentHash },
		})),
	).catch(async (error) => {
		await markClaimsFailed(env, claims, error);
		throw error;
	});
	const createdIds = new Set(created.map((instance) => instance.id));
	const existingClaims = claims.filter(({ resourceId, sourceContentHash }) => !createdIds.has(workflowId(resourceId, sourceContentHash)));
	const results = await Promise.allSettled(
		existingClaims.map(({ resourceId, sourceContentHash }) =>
			restartWorkflowIfInactive(env.CONTENT_LOCALIZATION_WORKFLOW, workflowId(resourceId, sourceContentHash)),
		),
	);
	let queued = created.length;
	let failed = 0;
	for (const [index, result] of results.entries()) {
		if (result.status === 'fulfilled') {
			queued++;
			continue;
		}
		failed++;
		const { resourceId, sourceContentHash } = existingClaims[index]!;
		await markContentLocalizationFailed(env, resourceId, sourceContentHash, result.reason).catch((error) =>
			console.error({
				tag: 'CONTENT_LOCALIZATION',
				msg: 'Failed to mark enqueue failure',
				resource_id: resourceId,
				error: String(error),
			}),
		);
	}
	console.info({
		tag: 'CONTENT_LOCALIZATION',
		msg: 'Backfill sweep queued',
		claimed: claims.length,
		queued,
		failed,
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
		const { resourceId, sourceContentHash } = event.payload;
		try {
			return await this.localizeResource(resourceId, sourceContentHash, step);
		} catch (error) {
			if (error instanceof ContentLocalizationSourceChangedError) throw error;
			const markFailed = error instanceof ContentTranslationLimitError ? exhaustContentLocalizationAttempts : markContentLocalizationFailed;
			await step
				.do(
					'mark-content-localization-failed',
					{
						retries: {
							limit: 3,
							delay: '5 seconds',
							backoff: 'exponential',
						},
						timeout: '30 seconds',
					},
					() => markFailed(this.env, resourceId, sourceContentHash, error),
				)
				.catch((markError) =>
					console.error({
						tag: 'CONTENT_LOCALIZATION',
						msg: 'Failed to record localization failure',
						resource_id: resourceId,
						error: String(markError),
					}),
				);
			throw error;
		}
	}

	private async localizeResource(resourceId: string, sourceContentHash: string, step: WorkflowStep) {
		const initial = await step.do(
			'load-content-localization-resource',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			async () => loadResourceForProcessing(this.env, resourceId),
		);
		if (!initial) throw new Error(`Resource ${resourceId} was not found`);
		if (initial.original_content_hash !== sourceContentHash) throw new ContentLocalizationSourceChangedError(resourceId);

		await step.do(
			'mark-content-localization-running',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			() => markContentLocalizationRunning(this.env, resourceId, sourceContentHash),
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
				() => clearMachineZhHantContent(this.env, resourceId, sourceContentHash),
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
					() => persistBackfilledZhHantContent(this.env, resourceId, sourceContentHash, sanitizedContent),
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
				() => persistMachineZhHantTranslation(this.env, resourceId, sourceContentHash, translatedMetadata),
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
				'persist-backfilled-zh-hant-content',
				{
					retries: {
						limit: 3,
						delay: '5 seconds',
						backoff: 'exponential',
					},
					timeout: '30 seconds',
				},
				() => persistBackfilledZhHantContent(this.env, resourceId, sourceContentHash, translated),
			);
		}

		await step.do(
			'mark-content-localization-complete',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			() => markContentLocalizationComplete(this.env, resourceId, sourceContentHash),
		);
		console.info({
			tag: 'CONTENT_LOCALIZATION',
			msg: 'Completed',
			resource_id: resourceId,
		});
		return { success: true, resource_id: resourceId };
	}
}
