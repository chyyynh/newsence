import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '@shared/types';
import { type ExtractInput, extractSource, type NormalizedContent } from '../extract';

// R2 prefix for uploads staged by POST /scrape/jobs. Objects here are ephemeral:
// the workflow deletes them after extraction (there is no R2 TTL convention in
// this repo). A lifecycle rule on `tmp/` is a belt-and-suspenders backstop.
export const TMP_SCRAPE_PREFIX = 'tmp/scrape/';

// Bytes can't fit Workflow params, so the job path only ever passes a URL or a
// staged R2 key — never inline bytes.
export type ScrapeWorkflowParams = Extract<ExtractInput, { kind: 'url' } | { kind: 'r2' }>;

// Non-persisting scrape job. Unlike NewsenceMonitorWorkflow this creates no DB
// row — the result is returned as the Workflow `output`, polled via
// GET /scrape/jobs/:id. Future OCR / AI-structuring steps slot in here (#166).
export class ScrapeWorkflow extends WorkflowEntrypoint<Env, ScrapeWorkflowParams> {
	async run(event: WorkflowEvent<ScrapeWorkflowParams>, step: WorkflowStep): Promise<NormalizedContent> {
		const input = event.payload;

		const result = (await step.do(
			'extract',
			{ retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' },
			() => extractSource(this.env, input),
		)) as NormalizedContent;

		if (input.kind === 'r2' && input.key.startsWith(TMP_SCRAPE_PREFIX)) {
			await step.do('cleanup', { retries: { limit: 2, delay: '5 seconds' }, timeout: '15 seconds' }, () => this.env.R2.delete(input.key));
		}

		console.info({ tag: 'SCRAPE_WORKFLOW', msg: 'Completed', kind: input.kind, status: result.status, chars: result.metadata.chars });
		return result;
	}
}
