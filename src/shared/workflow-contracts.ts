export type WorkflowStreamEvent = {
	error?: unknown;
	output?: unknown;
	status: string;
};

export type WorkflowStreamPhase = 'complete' | 'failed' | 'queued' | 'running' | 'waiting';

export const TERMINAL_WORKFLOW_STATUSES = ['complete', 'errored', 'error', 'terminated', 'timeout'] as const;

const TERMINAL_WORKFLOW_STATUS_SET = new Set<string>(TERMINAL_WORKFLOW_STATUSES);

export function isTerminalWorkflowStatus(status: string): boolean {
	return TERMINAL_WORKFLOW_STATUS_SET.has(status);
}

export function workflowStreamPhase(status: string): WorkflowStreamPhase {
	if (status === 'complete') return 'complete';
	if (isTerminalWorkflowStatus(status)) return 'failed';
	if (status === 'queued' || status === 'unknown') return 'queued';
	if (status === 'paused' || status === 'reconnecting' || status === 'waiting' || status === 'waitingForPause') {
		return 'waiting';
	}
	return 'running';
}

export function workflowStreamEvent(input: { error?: unknown; output?: unknown; status: string }): WorkflowStreamEvent {
	return {
		error: input.error,
		output: input.output,
		status: input.status,
	};
}

export function parseWorkflowStreamEvent(data: string): WorkflowStreamEvent | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;

	const payload = parsed as {
		error?: unknown;
		output?: unknown;
		status?: unknown;
	};
	if (typeof payload.status !== 'string' || !payload.status) return null;

	return workflowStreamEvent({
		error: payload.error,
		output: payload.output,
		status: payload.status,
	});
}
