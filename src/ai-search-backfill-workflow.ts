import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { listCorpusIdsAfter, syncCorpusItem } from './ai-search';

type CorpusSearchBackfillPayload = { cursor?: string };

const PAGE_SIZE = 50;
const UPLOAD_CONCURRENCY = 10;

export class CorpusSearchBackfillWorkflow extends WorkflowEntrypoint<CoreEnv, CorpusSearchBackfillPayload> {
	async run(event: WorkflowEvent<CorpusSearchBackfillPayload>, step: WorkflowStep) {
		let cursor = event.payload.cursor?.trim() || null;
		let uploaded = 0;
		let page = 0;

		while (true) {
			const ids = await step.do(
				`load-corpus-page-${page}`,
				{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
				() => listCorpusIdsAfter(this.env, cursor, PAGE_SIZE),
			);
			if (!ids.length) break;

			const pageUploaded = await step.do(
				`upload-corpus-page-${page}`,
				{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '300 seconds' },
				async () => {
					let count = 0;
					for (let offset = 0; offset < ids.length; offset += UPLOAD_CONCURRENCY) {
						const batch = ids.slice(offset, offset + UPLOAD_CONCURRENCY);
						const synced = await Promise.all(batch.map((id) => syncCorpusItem(this.env, id)));
						count += synced.filter((result) => result === 'uploaded').length;
					}
					return count;
				},
			);
			uploaded += pageUploaded;

			cursor = ids.at(-1)!;
			page++;
			console.info({ tag: 'AI_SEARCH', msg: 'Backfill page complete', page, cursor, uploaded });
		}

		return { uploaded, pages: page, cursor };
	}
}
