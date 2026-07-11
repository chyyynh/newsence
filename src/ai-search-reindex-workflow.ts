import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { listCorpusIdsAfter, syncCorpusItem } from './ai-search';
import { enqueueOrRestartWorkflow } from './workflow-control';

type CorpusSearchReindexPayload = { revision: string };

const CORPUS_SEARCH_INDEX_REVISION = 'v1';
const PAGE_SIZE = 50;
const UPLOAD_CONCURRENCY = 10;

export function startCorpusSearchReindex(env: CoreEnv): Promise<string> {
	return enqueueOrRestartWorkflow(env.CORPUS_SEARCH_REINDEX_WORKFLOW, `corpus-search-reindex-${CORPUS_SEARCH_INDEX_REVISION}`, {
		revision: CORPUS_SEARCH_INDEX_REVISION,
	});
}

export class CorpusSearchReindexWorkflow extends WorkflowEntrypoint<CoreEnv, CorpusSearchReindexPayload> {
	async run(event: WorkflowEvent<CorpusSearchReindexPayload>, step: WorkflowStep) {
		let cursor: string | null = null;
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
			console.info({ tag: 'AI_SEARCH', msg: 'Reindex page complete', revision: event.payload.revision, page, cursor, uploaded });
		}

		return { revision: event.payload.revision, uploaded, pages: page, cursor };
	}
}
