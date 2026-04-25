import { WorkerEntrypoint } from 'cloudflare:workers';
import { NewsenceMonitorWorkflow } from './app/workflows/article-processing.workflow';
import { routeRequest } from './entrypoints/http';
import { handleQueue } from './entrypoints/queue';
import { type SubmitUrlRpcArgs, submitUrlRpc } from './entrypoints/rpc';
import { handleScheduled } from './entrypoints/scheduled';
import type { Env, MessageBatch, QueueMessage, ScheduledEvent } from './models/types';

export { NewsenceMonitorWorkflow };

export default class CoreWorker extends WorkerEntrypoint<Env> {
	override async fetch(request: Request): Promise<Response> {
		return routeRequest(request, this.env);
	}

	async scheduled(event: ScheduledEvent): Promise<void> {
		handleScheduled(event, this.env, this.ctx);
	}

	async queue(batch: MessageBatch<QueueMessage>): Promise<void> {
		await handleQueue(batch, this.env);
	}

	async submitUrl(args: SubmitUrlRpcArgs) {
		return submitUrlRpc(this.env, args);
	}
}
