import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { createClient } from '@supabase/supabase-js';
import { Env } from '../types';

type MonitorWorkflowParams = {
	source: 'rss' | 'twitter' | 'manual';
	article_ids?: string[];
	metadata?: Record<string, any>;
};

export class NewsenceMonitorWorkflow extends WorkflowEntrypoint<Env, MonitorWorkflowParams> {
	async run(event: WorkflowEvent<MonitorWorkflowParams>, step: WorkflowStep) {
		const supabase = createClient(this.env.SUPABASE_URL, this.env.SUPABASE_SERVICE_ROLE_KEY);
		const { source, article_ids = [] } = event.payload;

		console.log(`[WORKFLOW] Starting Newsence Monitor Workflow: ${event.instanceId} for source: ${source}`);

		await step.do('log-workflow-start', async (): Promise<void> => {
			await supabase.from('workflow_executions').insert({
				workflow_name: 'newsence-monitor-workflow',
				status: 'running',
				started_at: new Date().toISOString(),
				metadata: {
					source,
					instanceId: event.instanceId,
					article_count: article_ids.length,
				},
			});
		});

		await step.do(
			'send-to-processing-queue',
			{
				retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' },
				timeout: '5 minutes',
			},
			async (): Promise<any> => {
				console.log(`[WORKFLOW] Sending ${article_ids.length} articles to processing queue individually`);

				for (const articleId of article_ids) {
					await this.env.ARTICLE_QUEUE.send({
						type: 'process_articles',
						source,
						article_ids: [articleId],
						triggered_by: 'workflow-orchestrator',
						metadata: {
							workflow_instance: event.instanceId,
							timestamp: new Date().toISOString(),
						},
					});
					console.log(`[WORKFLOW] Sent article ${articleId} to processing queue`);
				}

				return {
					total_articles: article_ids.length,
					source,
					processing_approach: 'individual_concurrent',
				};
			}
		);

		await step.do('log-workflow-completion', async (): Promise<void> => {
			await supabase.from('workflow_executions').insert({
				workflow_name: 'newsence-monitor-workflow',
				status: 'completed',
				started_at: new Date().toISOString(),
				completed_at: new Date().toISOString(),
				metadata: {
					source,
					instanceId: event.instanceId,
					triggered_processing: true,
				},
			});
			console.log(`[WORKFLOW] Workflow ${event.instanceId} completed successfully`);
		});

		return {
			success: true,
			instanceId: event.instanceId,
			source,
			message: 'Article processing triggered',
		};
	}
}
