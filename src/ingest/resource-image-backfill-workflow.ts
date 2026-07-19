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
		let available = 0;
		let attempted = 0;
		let existing = 0;
		let failed = 0;
		let resources = 0;
		let stored = 0;
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
			available += result.available;
			attempted += result.attempted;
			existing += result.existing;
			failed += result.failed;
			resources += result.resources;
			stored += result.stored;

			console.info(
				JSON.stringify({
					tag: 'OG_IMAGE',
					event: 'recent_backfill_page_completed',
					page,
					resources: result.resources,
					attempted: result.attempted,
					available: result.available,
					existing: result.existing,
					stored: result.stored,
					failed: result.failed,
				}),
			);
			for (const item of result.items) {
				if (item.failed === 0) continue;
				console.warn(
					JSON.stringify({
						tag: 'OG_IMAGE',
						event: 'recent_backfill_resource_failed',
						page,
						resource_id: item.resourceId,
						failures: item.outcomes.filter((outcome) => outcome.state === 'failed'),
					}),
				);
			}
			if (!result.nextCursor) {
				return {
					...window,
					days,
					resources,
					attempted,
					available,
					existing,
					stored,
					failed,
				};
			}
			cursor = result.nextCursor;
		}

		throw new NonRetryableError(`Resource image backfill exceeded ${MAX_PAGES} pages`, 'ResourceImageBackfillPageLimitError');
	}
}
