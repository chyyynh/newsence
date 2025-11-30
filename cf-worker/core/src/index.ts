import { Env, ScheduledEvent, ExecutionContext, MessageBatch, QueueMessage } from './types';
import { handleHealth } from './handlers/health';
import { handleStatus } from './handlers/status';
import { handleManualTrigger } from './handlers/trigger';
import { handleWebhook } from './handlers/webhook';
import { handleRSSCron } from './cron/rss-monitor';
import { handleTwitterCron } from './cron/twitter-monitor';
import { handleTwitterSummaryCron } from './cron/twitter-summary';
import { handleArticleDailyCron } from './cron/article-daily';
import { handleRSSQueue } from './queue/rss-consumer';
import { handleTwitterQueue } from './queue/twitter-consumer';
import { handleArticleQueue } from './queue/article-consumer';
import { NewsenceMonitorWorkflow } from './workflow/orchestrator';

export { NewsenceMonitorWorkflow };

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return handleHealth(env);
		}

		if (url.pathname === '/status') {
			return handleStatus(env);
		}

		if (url.pathname === '/trigger' && request.method === 'POST') {
			return handleManualTrigger(request, env, ctx);
		}

		// WebSocket webhook endpoint for receiving messages from WebSocket forwarder
		if (url.pathname === '/webhook' && request.method === 'POST') {
			return handleWebhook(request, env, ctx);
		}

		// Manual cron triggers for local/remote testing without __scheduled
		if (url.pathname === '/cron/rss' && request.method === 'POST') {
			ctx.waitUntil(handleRSSCron(env, ctx));
			return new Response(JSON.stringify({ status: 'started', cron: 'rss-monitor' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		if (url.pathname === '/cron/twitter' && request.method === 'POST') {
			ctx.waitUntil(handleTwitterCron(env, ctx));
			return new Response(JSON.stringify({ status: 'started', cron: 'twitter-monitor' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		if (url.pathname === '/cron/twitter-summary' && request.method === 'POST') {
			ctx.waitUntil(handleTwitterSummaryCron(env, ctx));
			return new Response(JSON.stringify({ status: 'started', cron: 'twitter-summary' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}
		if (url.pathname === '/cron/article-daily' && request.method === 'POST') {
			ctx.waitUntil(handleArticleDailyCron(env, ctx));
			return new Response(JSON.stringify({ status: 'started', cron: 'article-daily' }), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response(
			'Newsence Core Worker (Test)\n\n' +
			'Available endpoints:\n' +
			'GET /health - Health check\n' +
			'GET /status - Worker status\n' +
			'POST /trigger - Manually trigger article processing\n' +
			'POST /webhook - Receive WebSocket messages\n' +
			'POST /cron/rss - Trigger RSS monitor\n' +
			'POST /cron/twitter - Trigger Twitter monitor\n' +
			'POST /cron/twitter-summary - Trigger Twitter summary\n' +
			'POST /cron/article-daily - Trigger article daily processing\n',
			{
				headers: { 'Content-Type': 'text/plain' }
			}
		);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		const cron = event.cron;
		console.log(`[CORE] Scheduled event triggered: ${cron}`);

		try {
			if (cron === '*/5 * * * *') {
				ctx.waitUntil(handleRSSCron(env, ctx));
				ctx.waitUntil(handleTwitterSummaryCron(env, ctx));
			} else if (cron === '0 */6 * * *') {
				ctx.waitUntil(handleTwitterCron(env, ctx));
			} else if (cron === '0 3 * * *') {
				ctx.waitUntil(handleArticleDailyCron(env, ctx));
			}
		} catch (error) {
			console.error('[CORE] Error in scheduled handler:', error);
			throw error;
		}
	},

	async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
		const queueName = batch.queue;
		console.log(`[CORE] Processing ${batch.messages.length} messages from queue: ${queueName}`);

		try {
			if (queueName === 'rss-scraping-queue-core') {
				await handleRSSQueue(batch, env, ctx);
			} else if (queueName === 'twitter-processing-queue-core') {
				await handleTwitterQueue(batch, env, ctx);
			} else if (queueName === 'article-processing-queue-core') {
				await handleArticleQueue(batch, env, ctx);
			} else {
				console.warn(`[CORE] Unknown queue received: ${queueName}, acknowledging messages`);
				for (const message of batch.messages) {
					message.ack();
				}
			}
		} catch (error) {
			console.error('[CORE] Error in queue handler:', error);
			throw error;
		}
	}
};
