export type WorkflowStreamEvent = {
	error?: unknown;
	output?: unknown;
	status: string;
};

const TERMINAL_WORKFLOW_STATUSES = ['complete', 'errored', 'error', 'terminated', 'timeout'] as const;

const TERMINAL_WORKFLOW_STATUS_SET = new Set<string>(TERMINAL_WORKFLOW_STATUSES);

export function isTerminalWorkflowStatus(status: string): boolean {
	return TERMINAL_WORKFLOW_STATUS_SET.has(status);
}

export function workflowStreamEvent(input: { error?: unknown; output?: unknown; status: string }): WorkflowStreamEvent {
	return {
		error: input.error,
		output: input.output,
		status: input.status,
	};
}
