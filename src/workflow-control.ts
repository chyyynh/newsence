import type { WorkflowDelayFunction } from 'cloudflare:workers';

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

const durableWorkflowRetryDelay: WorkflowDelayFunction = ({ ctx }) =>
	ctx.attempt <= 5 ? '10 seconds' : ctx.attempt <= 60 ? '1 minute' : '15 minutes';

export const DURABLE_WORKFLOW_RETRIES = {
	limit: 10_000,
	delay: durableWorkflowRetryDelay,
} as const;

export async function enqueueOrRestartWorkflow<Params>(workflow: Workflow<Params>, id: string, params: Params): Promise<string> {
	const [created] = await workflow.createBatch([{ id, params }]);
	if (created) return created.id;
	const instance = await workflow.get(id);
	const { status } = await instance.status();
	if (!ACTIVE_WORKFLOW_STATUSES.has(status)) await instance.restart();
	return instance.id;
}
