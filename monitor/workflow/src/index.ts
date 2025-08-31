import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { createClient } from '@supabase/supabase-js';

type Env = {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	ARTICLE_PROCESS: Fetcher;
	RSS_FEED_MONITOR: Fetcher;
	TWITTER_MONITOR: Fetcher;
	MONITOR_WORKFLOW: Workflow;
	ARTICLE_PROCESSING_QUEUE: Queue;
};

type MonitorWorkflowParams = {
	source: 'rss' | 'twitter' | 'manual';
	article_ids?: string[];
	metadata?: Record<string, any>;
};

// Workflow for coordinating RSS monitoring and article processing
export class OpenNewsMonitorWorkflow extends WorkflowEntrypoint<Env, MonitorWorkflowParams> {
	async run(event: WorkflowEvent<MonitorWorkflowParams>, step: WorkflowStep) {
		const supabase = createClient(this.env.SUPABASE_URL, this.env.SUPABASE_SERVICE_ROLE_KEY);

		console.log(`Starting OpenNews Monitor Workflow: ${event.instanceId} for source: ${event.payload.source}`);

		// Step 1: Log workflow start
		await step.do('log-workflow-start', async (): Promise<void> => {
			await supabase.from('workflow_executions').insert({
				workflow_name: 'opennews-monitor-workflow',
				status: 'running',
				started_at: new Date().toISOString(),
				metadata: {
					source: event.payload.source,
					instanceId: event.instanceId,
					article_count: event.payload.article_ids?.length || 0,
				},
			});
			console.log('Workflow execution logged');
		});

		// Step 2: Send article batches to processing queue
		if (event.payload.source === 'rss' || event.payload.source === 'twitter' || event.payload.source === 'manual') {
			await step.do(
				'send-to-processing-queue',
				{
					retries: {
						limit: 3,
						delay: '30 seconds',
						backoff: 'exponential',
					},
					timeout: '5 minutes',
				},
				async (): Promise<any> => {
					const articleIds = event.payload.article_ids || [];
					console.log(`Sending ${articleIds.length} articles to processing queue in batches`);

					// Split article IDs into batches matching queue consumer config (10)
					// This matches the max_batch_size in article-process queue config
					const BATCH_SIZE = 10;
					const batches = [];
					for (let i = 0; i < articleIds.length; i += BATCH_SIZE) {
						batches.push(articleIds.slice(i, i + BATCH_SIZE));
					}

					console.log(`Created ${batches.length} batches of up to ${BATCH_SIZE} articles each`);

					// Send each batch to the queue
					const queueMessages = batches.map(batch => ({
						body: {
							type: 'process_articles',
							source: event.payload.source,
							article_ids: batch,
							triggered_by: 'workflow-orchestrator',
							batch_info: {
								batch_size: batch.length,
								total_batches: batches.length,
								timestamp: new Date().toISOString()
							}
						}
					}));

					// Send all batches to queue
					await this.env.ARTICLE_PROCESSING_QUEUE.sendBatch(queueMessages);

					const result = {
						total_articles: articleIds.length,
						total_batches: batches.length,
						batch_size: BATCH_SIZE,
						source: event.payload.source
					};

					console.log('Article batches sent to processing queue:', result);
					return result;
				}
			);
		}

		// Step 3: Log workflow completion
		await step.do('log-workflow-completion', async (): Promise<void> => {
			await supabase.from('workflow_executions').insert({
				workflow_name: 'opennews-monitor-workflow',
				status: 'completed',
				started_at: new Date().toISOString(),
				completed_at: new Date().toISOString(),
				metadata: {
					source: event.payload.source,
					instanceId: event.instanceId,
					triggered_processing: true,
				},
			});
			console.log(`Workflow ${event.instanceId} completed successfully`);
		});

		return {
			success: true,
			instanceId: event.instanceId,
			source: event.payload.source,
			message: 'Article processing triggered',
		};
	}
}

// Add workflow deduplication and rate limiting
const WORKFLOW_COOLDOWN = 5 * 60 * 1000; // 5 minutes cooldown between workflows of same type
const lastWorkflowTimes: { [key: string]: number } = {};

function shouldCreateWorkflow(source: string): boolean {
	const now = Date.now();
	const lastRun = lastWorkflowTimes[source] || 0;
	const cooldownPeriod = now - lastRun;

	if (cooldownPeriod < WORKFLOW_COOLDOWN) {
		console.log(`Skipping ${source} workflow - cooldown period (${Math.round(cooldownPeriod / 1000)}s < ${WORKFLOW_COOLDOWN / 1000}s)`);
		return false;
	}

	return true;
}

function markWorkflowCreated(source: string): void {
	lastWorkflowTimes[source] = Date.now();
}

export default {
	// Handle queue messages from RSS feed monitor
	async queue(batch: any, env: Env): Promise<void> {
		console.log(`Processing ${batch.messages.length} queue messages`);

		// Group messages by type for batch processing and collect article IDs
		const rssMessages: any[] = [];
		const twitterMessages: any[] = [];
		const articleIds: string[] = [];

		for (const message of batch.messages) {
			try {
				const messageData = message.body;

				if (messageData.type === 'article_scraped') {
					rssMessages.push(message);
					if (messageData.article_id) {
						articleIds.push(messageData.article_id);
					}
				} else if (messageData.type === 'tweet_scraped') {
					twitterMessages.push(message);
					if (messageData.article_id) {
						articleIds.push(messageData.article_id);
					}
				} else {
					console.warn('Unknown message type:', messageData.type);
					message.ack(); // Acknowledge unknown message types
				}
			} catch (error) {
				console.error('Error parsing message:', error);
				message.retry();
			}
		}

		// Process RSS messages - ONE workflow for the entire batch with rate limiting
		if (rssMessages.length > 0) {
			if (shouldCreateWorkflow('rss')) {
				try {
					const messageIds = rssMessages.map((m) => m.id);
					const rssArticleIds = rssMessages
						.map((m) => m.body.article_id)
						.filter(Boolean);

					const instance = await env.MONITOR_WORKFLOW.create({
						params: {
							source: 'rss',
							article_ids: rssArticleIds,
							metadata: {
								trigger_time: new Date().toISOString(),
								message_ids: messageIds,
								batch_size: rssMessages.length,
								article_count: rssArticleIds.length,
							},
						},
					});

					markWorkflowCreated('rss');
					console.log(`Started single workflow instance ${instance.id} for ${rssMessages.length} RSS messages with ${rssArticleIds.length} article IDs`);

					// Acknowledge all RSS messages
					rssMessages.forEach((message) => message.ack());
				} catch (error) {
					console.error('Error creating RSS workflow:', error);
					rssMessages.forEach((message) => message.retry());
				}
			} else {
				// Still acknowledge messages during cooldown to avoid reprocessing
				console.log(`Acknowledging ${rssMessages.length} RSS messages during cooldown`);
				rssMessages.forEach((message) => message.ack());
			}
		}

		// Process Twitter messages - ONE workflow for the entire batch with rate limiting
		if (twitterMessages.length > 0) {
			if (shouldCreateWorkflow('twitter')) {
				try {
					const messageIds = twitterMessages.map((m) => m.id);
					const twitterArticleIds = twitterMessages
						.map((m) => m.body.article_id)
						.filter(Boolean);

					const instance = await env.MONITOR_WORKFLOW.create({
						params: {
							source: 'twitter',
							article_ids: twitterArticleIds,
							metadata: {
								trigger_time: new Date().toISOString(),
								message_ids: messageIds,
								batch_size: twitterMessages.length,
								article_count: twitterArticleIds.length,
							},
						},
					});

					markWorkflowCreated('twitter');
					console.log(`Started single workflow instance ${instance.id} for ${twitterMessages.length} Twitter messages with ${twitterArticleIds.length} article IDs`);

					// Acknowledge all Twitter messages
					twitterMessages.forEach((message) => message.ack());
				} catch (error) {
					console.error('Error creating Twitter workflow:', error);
					twitterMessages.forEach((message) => message.retry());
				}
			} else {
				// Still acknowledge messages during cooldown to avoid reprocessing
				console.log(`Acknowledging ${twitterMessages.length} Twitter messages during cooldown`);
				twitterMessages.forEach((message) => message.ack());
			}
		}
	},
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

		if (url.pathname === '/favicon.ico') {
			return new Response(null, { status: 404 });
		}

		// Trigger manual workflow
		if (url.pathname === '/trigger' && req.method === 'POST') {
			try {
				const body: any = await req.json().catch(() => ({}));
				const source = body.source || 'manual';
				const articleIds = body.article_ids || [];

				const instance = await env.MONITOR_WORKFLOW.create({
					params: {
						source: source,
						article_ids: articleIds,
						metadata: {
							trigger_time: new Date().toISOString(),
							manual_trigger: true,
						},
					},
				});

				return Response.json({
					success: true,
					instanceId: instance.id,
					message: `Workflow started for ${source} source`,
					article_count: articleIds.length,
				});
			} catch (error) {
				return Response.json(
					{
						success: false,
						error: error instanceof Error ? error.message : 'Unknown error',
					},
					{ status: 500 }
				);
			}
		}

		// Get workflow status
		if (url.pathname === '/status') {
			const instanceId = url.searchParams.get('instanceId');

			if (instanceId) {
				try {
					const instance = await env.MONITOR_WORKFLOW.get(instanceId);
					return Response.json({
						instanceId,
						status: await instance.status(),
					});
				} catch (error) {
					return Response.json(
						{
							error: 'Workflow instance not found',
						},
						{ status: 404 }
					);
				}
			}

			// Get recent workflow executions
			try {
				const { data: workflows } = await supabase
					.from('workflow_executions')
					.select('*')
					.eq('workflow_name', 'opennews-monitor-workflow')
					.order('started_at', { ascending: false })
					.limit(10);

				return Response.json({
					recent_workflows: workflows || [],
				});
			} catch (error) {
				return Response.json(
					{
						error: 'Failed to fetch workflow history',
					},
					{ status: 500 }
				);
			}
		}

		// Trigger Twitter workflow (can be called by Twitter monitor service)
		if (url.pathname === '/trigger-twitter' && req.method === 'POST') {
			try {
				const instance = await env.MONITOR_WORKFLOW.create({
					params: {
						source: 'twitter',
						metadata: {
							trigger_time: new Date().toISOString(),
							triggered_by: 'twitter-monitor',
						},
					},
				});

				return Response.json({
					success: true,
					instanceId: instance.id,
					message: 'Twitter processing workflow started',
				});
			} catch (error) {
				return Response.json(
					{
						success: false,
						error: error instanceof Error ? error.message : 'Unknown error',
					},
					{ status: 500 }
				);
			}
		}

		// Health check
		if (url.pathname === '/health') {
			return Response.json({
				service: 'opennews-workflow-orchestrator',
				status: 'healthy',
				timestamp: new Date().toISOString(),
				services: {
					article_process: 'bound',
					rss_feed_monitor: 'bound',
					twitter_monitor: 'bound',
				},
			});
		}

		// Default response
		return new Response(
			`OpenNews Workflow Orchestrator
				Available endpoints:
				- POST /trigger - Manually trigger workflow
				- POST /trigger-twitter - Trigger Twitter processing workflow  
				- GET /status - Get workflow status and history
				- GET /health - Health check

				This service orchestrates RSS feed monitoring, Twitter monitoring, and article processing workflows using Cloudflare Workflows.

				Usage:
				- POST /trigger with { "source": "manual", "article_ids": ["id1", "id2"] }
				- GET /status?instanceId=<id> for specific instance status
				`,
			{
				headers: { 'Content-Type': 'text/plain' },
			}
		);
	},
};
