import { WorkerEntrypoint } from 'cloudflare:workers';

export { SearchIndexTerminalRepair251Workflow } from './ai-search';

export default class SearchTerminalRepair251Worker extends WorkerEntrypoint {
	override fetch(): Response {
		return new Response('Not found', { status: 404 });
	}
}
