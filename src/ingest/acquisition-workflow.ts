import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { type AcquiredContent, scrapeSavedUrl, validateAcquisitionUrl } from './acquisition';

export type AcquisitionWorkflowParams = {
	url: string;
};

function acquisitionWorkflowInstanceId(): string {
	return `acquisition-${crypto.randomUUID()}`;
}

export async function createAcquisitionJob(env: CoreEnv, url: string) {
	const validatedUrl = validateAcquisitionUrl(url);
	const instance = await env.ACQUISITION_WORKFLOW.create({
		id: acquisitionWorkflowInstanceId(),
		params: { url: validatedUrl },
	});
	return {
		id: instance.id,
		details: await instance.status(),
	};
}

export async function getAcquisitionJobStatus(env: CoreEnv, instanceId: string) {
	const instance = await env.ACQUISITION_WORKFLOW.get(instanceId);
	return instance.status();
}

export class AcquisitionWorkflow extends WorkflowEntrypoint<CoreEnv, AcquisitionWorkflowParams> {
	async run(event: WorkflowEvent<AcquisitionWorkflowParams>, step: WorkflowStep): Promise<AcquiredContent | null> {
		return step.do('acquire', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '120 seconds' }, () =>
			scrapeSavedUrl(event.payload.url, this.env),
		);
	}
}
