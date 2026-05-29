import { USER_FILES_TABLE } from '@shared/db/articles';
import { logError } from '@shared/log';
import type { Env } from '@shared/types';

export async function createUserFileWorkflow(env: Env, userFileId: string, sourceType: string): Promise<string | undefined> {
	try {
		const instance = await env.MONITOR_WORKFLOW.create({
			params: { article_id: userFileId, source_type: sourceType, target_table: USER_FILES_TABLE },
		});
		return instance.id;
	} catch (err) {
		logError('WORKFLOW', 'create failed', { userFileId, sourceType, error: String(err) });
		return undefined;
	}
}
