const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'paused', 'waiting', 'waitingForPause']);

export async function enqueueOrRestartWorkflow<Params>(workflow: Workflow<Params>, id: string, params: Params): Promise<string> {
	const [created] = await workflow.createBatch([{ id, params }]);
	if (created) return created.id;
	const instance = await workflow.get(id);
	const { status } = await instance.status();
	if (!ACTIVE_WORKFLOW_STATUSES.has(status)) await instance.restart();
	return instance.id;
}
