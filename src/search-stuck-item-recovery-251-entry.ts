import { WorkerEntrypoint } from 'cloudflare:workers';

export { SearchIndexStuckItem251RecoveryWorkflow } from './search-stuck-item-recovery-251';

export default class SearchStuckItemRecovery251Worker extends WorkerEntrypoint {
	override fetch(): Response {
		return new Response('Not found', { status: 404 });
	}
}
