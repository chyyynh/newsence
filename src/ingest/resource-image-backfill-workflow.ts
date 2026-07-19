import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const DEFAULT_BACKFILL_DAYS = 7;
const MAX_BACKFILL_DAYS = 7;
const PAGE_SIZE = 10;
const MAX_PAGES = 2500;

type ResourceImageBackfillPayload = { days?: number };

function backfillDays(value: number | undefined): number {
	const days = value ?? DEFAULT_BACKFILL_DAYS;
	if (!Number.isInteger(days) || days < 1 || days > MAX_BACKFILL_DAYS) {
		throw new NonRetryableError('Resource image backfill days must be an integer from 1 through 7', 'ResourceImageBackfillInputError');
	}
	return days;
}

export class RecentResourceImageBackfillWorkflow extends WorkflowEntrypoint<CoreEnv, ResourceImageBackfillPayload> {
	async run(event: WorkflowEvent<ResourceImageBackfillPayload>, step: WorkflowStep) {
		const days = backfillDays(event.payload.days);
		const window = await step.do(
			'resolve-recent-image-window',
			{ retries: { limit: 0, delay: '1 second' }, timeout: '5 seconds' },
			async () => {
				const effectiveBefore = new Date();
				const effectiveAfter = new Date(effectiveBefore.getTime() - days * 24 * 60 * 60 * 1000);
				return {
					effectiveAfter: effectiveAfter.toISOString(),
					effectiveBefore: effectiveBefore.toISOString(),
				};
			},
		);

		let cursor: string | null = null;
		let attempted = 0;
		let rehosted = 0;
		let resources = 0;
		for (let page = 1; page <= MAX_PAGES; page++) {
			const result = await step.do(
				`rehost-recent-images-page-${page}`,
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' },
				() =>
					this.env.DOMAIN.rehostRecentResourceImagesPage({
						...window,
						cursor,
						limit: PAGE_SIZE,
					}),
			);
			attempted += result.attempted;
			rehosted += result.rehosted;
			resources += result.resources;

			console.info({
				tag: 'OG_IMAGE',
				msg: 'Recent resource image backfill page completed',
				page,
				resources: result.resources,
				attempted: result.attempted,
				rehosted: result.rehosted,
			});
			if (!result.nextCursor) {
				return {
					...window,
					days,
					resources,
					attempted,
					rehosted,
					failed: attempted - rehosted,
				};
			}
			cursor = result.nextCursor;
		}

		throw new NonRetryableError(`Resource image backfill exceeded ${MAX_PAGES} pages`, 'ResourceImageBackfillPageLimitError');
	}
}
