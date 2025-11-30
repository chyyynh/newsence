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

		// Step 2: Send individual article to processing queue  
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
					console.log(`Sending ${articleIds.length} articles to processing queue individually`);

					// Send each article individually to maximize concurrency
					for (const articleId of articleIds) {
						await this.env.ARTICLE_PROCESSING_QUEUE.send({
							type: 'process_articles',
							source: event.payload.source,
							article_ids: [articleId],
							triggered_by: 'workflow-orchestrator',
							metadata: {
								workflow_instance: event.instanceId,
								timestamp: new Date().toISOString()
							}
						});

						console.log(`Sent article ${articleId} to processing queue`);
					}

					const result = {
						total_articles: articleIds.length,
						source: event.payload.source,
						processing_approach: 'individual_concurrent'
					};

					console.log('All articles sent to processing queue individually:', result);
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

// Remove workflow cooldown mechanism - allow full concurrency for better performance

export default {
	// Handle queue messages from RSS feed monitor - one workflow per article for maximum concurrency
	async queue(batch: any, env: Env): Promise<void> {
		console.log(`Processing ${batch.messages.length} queue messages with individual workflows`);

		// Process each message individually to maximize concurrency
		for (const message of batch.messages) {
			try {
				const messageData = message.body;

				if (messageData.type === 'article_scraped') {
					// Create individual workflow for each article
					const instance = await env.MONITOR_WORKFLOW.create({
						params: {
							source: messageData.source_type || 'rss',
							article_ids: [messageData.article_id],
							metadata: {
								trigger_time: new Date().toISOString(),
								message_id: message.id,
								source: messageData.source,
								url: messageData.url,
							},
						},
					});

					console.log(`Started workflow instance ${instance.id} for article ${messageData.article_id}`);
					message.ack();

				} else if (messageData.type === 'tweet_scraped') {
					// Create individual workflow for each tweet
					const instance = await env.MONITOR_WORKFLOW.create({
						params: {
							source: 'twitter',
							article_ids: [messageData.article_id],
							metadata: {
								trigger_time: new Date().toISOString(),
								message_id: message.id,
								source: messageData.source,
								url: messageData.url,
							},
						},
					});

					console.log(`Started workflow instance ${instance.id} for tweet ${messageData.article_id}`);
					message.ack();

				} else {
					console.warn('Unknown message type:', messageData.type);
					message.ack(); // Acknowledge unknown message types
				}
			} catch (error) {
				console.error('Error creating workflow for message:', error);
				message.retry();
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
