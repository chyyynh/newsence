import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
	claimContentLocalizationBackfill,
	exhaustContentLocalizationAttempts,
	markContentLocalizationComplete,
	markContentLocalizationFailed,
	markContentLocalizationRunning,
	persistBackfilledOriginalContent,
	persistBackfilledZhHantContent,
} from '@ingest/domain/content-localization-store';
import { loadResourceForProcessing } from '@ingest/domain/resource-store';
import { readAcquiredContentArtifact, scrapeSavedUrlArtifact } from './acquisition';
import {
	assembleZhHantContentTranslation,
	ContentTranslationLimitError,
	createZhHantContentTranslationChunks,
	DURABLE_CONTENT_TRANSLATION_MAX_CHUNKS,
	needsZhHantContentTranslation,
	translateZhHantContentChunk,
} from './domain/ai-utils';
import { applyAcquiredContent } from './domain/resource-update';

type ContentLocalizationPayload = { resourceId: string };

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);
const TRANSLATION_STEP_CONCURRENCY = 3;
const CONTENT_LOCALIZATION_WORKFLOW_REVISION = 'v2';

function workflowId(resourceId: string): string {
	return `content-localization-${CONTENT_LOCALIZATION_WORKFLOW_REVISION}-${resourceId}`;
}

async function markClaimsFailed(env: CoreEnv, claims: Array<{ resourceId: string }>, error: unknown): Promise<void> {
	await Promise.allSettled(claims.map(({ resourceId }) => markContentLocalizationFailed(env, resourceId, error)));
}

export async function scheduleContentLocalizationBackfill(env: CoreEnv): Promise<void> {
	const claims = await claimContentLocalizationBackfill(env);
	if (!claims.length) return;

	const created = await env.CONTENT_LOCALIZATION_WORKFLOW.createBatch(
		claims.map(({ resourceId }) => ({ id: workflowId(resourceId), params: { resourceId } })),
	).catch(async (error) => {
		await markClaimsFailed(env, claims, error);
		throw error;
	});
	const createdIds = new Set(created.map((instance) => instance.id));
	const existingClaims = claims.filter(({ resourceId }) => !createdIds.has(workflowId(resourceId)));
	const results = await Promise.allSettled(
		existingClaims.map(async ({ resourceId }) => {
			const instance = await env.CONTENT_LOCALIZATION_WORKFLOW.get(workflowId(resourceId));
			const { status } = await instance.status();
			if (!ACTIVE_WORKFLOW_STATUSES.has(status)) await instance.restart();
		}),
	);
	let queued = created.length;
	let failed = 0;
	for (const [index, result] of results.entries()) {
		if (result.status === 'fulfilled') {
			queued++;
			continue;
		}
		failed++;
		const resourceId = existingClaims[index]!.resourceId;
		await markContentLocalizationFailed(env, resourceId, result.reason).catch((error) =>
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
		const { resourceId } = event.payload;
		try {
			return await this.localizeResource(resourceId, step);
		} catch (error) {
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
					() => markFailed(this.env, resourceId, error),
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

	private async localizeResource(resourceId: string, step: WorkflowStep) {
		await step.do(
			'mark-content-localization-running',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			() => markContentLocalizationRunning(this.env, resourceId),
		);

		const initial = await step.do(
			'load-content-localization-resource',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			async () => loadResourceForProcessing(this.env, resourceId),
		);
		if (!initial) throw new Error(`Resource ${resourceId} was not found`);

		let resource = initial;
		if (!resource.content?.trim()) {
			if (!resource.url) throw new Error(`Resource ${resourceId} has no URL to acquire`);
			const artifact = await step.do(
				'acquire-missing-original-content',
				{
					retries: {
						limit: 3,
						delay: '15 seconds',
						backoff: 'exponential',
					},
					timeout: '180 seconds',
				},
				() =>
					scrapeSavedUrlArtifact(resource.url, this.env, {
						allowRenderedFallback: resource.scope === 'corpus',
					}),
			);
			const acquired = await readAcquiredContentArtifact(artifact);
			resource = {
				...applyAcquiredContent(resource, acquired),
				original_lang: initial.original_lang,
			};
			const originalContent = resource.content?.trim();
			if (!originalContent) {
				throw new Error(`Resource ${resourceId} acquisition returned no content`);
			}
			await step.do(
				'persist-backfilled-original-content',
				{
					retries: {
						limit: 3,
						delay: '5 seconds',
						backoff: 'exponential',
					},
					timeout: '30 seconds',
				},
				() => persistBackfilledOriginalContent(this.env, resourceId, resource.original_lang, originalContent),
			);
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
				() => persistBackfilledZhHantContent(this.env, resourceId, translated),
			);
		}

		await step.do(
			'mark-content-localization-complete',
			{
				retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
				timeout: '30 seconds',
			},
			() => markContentLocalizationComplete(this.env, resourceId),
		);
		console.info({
			tag: 'CONTENT_LOCALIZATION',
			msg: 'Completed',
			resource_id: resourceId,
		});
		return { success: true, resource_id: resourceId };
	}
}
