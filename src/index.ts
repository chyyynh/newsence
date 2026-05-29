import { WorkerEntrypoint } from 'cloudflare:workers';
import { routeRequest } from '@entry/http';
import { handleQueue } from '@entry/queue';
import { handleScheduled } from '@entry/scheduled';
import { NewsenceMonitorWorkflow } from '@ingest/workflows/article-processing.workflow';
import type { Env, MessageBatch, QueueMessage, ScheduledEvent } from '@shared/types';

export { NewsenceMonitorWorkflow };

export default class CoreWorker extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		return routeRequest(request, this.env, this.ctx);
	}

	scheduled(event: ScheduledEvent): void {
		handleScheduled(event, this.env, this.ctx);
	}

	async queue(batch: MessageBatch<QueueMessage>): Promise<void> {
		await handleQueue(batch, this.env);
	}
}
