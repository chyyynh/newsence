import { ARTICLES_TABLE, createDbClient } from '../../infra/db';
import { logError } from '../../infra/log';
import type { Env } from '../../models/types';

const ARTICLE_FIELDS =
	'id, title, title_cn, summary, summary_cn, content_cn, source, source_type, og_image_url, published_date, tags, keywords, url';

export async function handleWorkflowStatus(instanceId: string, env: Env): Promise<Response> {
	try {
		const instance = await env.MONITOR_WORKFLOW.get(instanceId);
		const { status, output, error } = await instance.status();

		if (status === 'complete') {
			const articleId = (output as Record<string, unknown> | undefined)?.article_id as string | undefined;
			if (articleId) {
				const db = await createDbClient(env);
				try {
					const table = ARTICLES_TABLE;
					const result = await db.query(`SELECT ${ARTICLE_FIELDS} FROM ${table} WHERE id = $1`, [articleId]);
					const article = result.rows[0];
					return Response.json({ status: 'complete', article });
				} finally {
					await db.end();
				}
			}
			return Response.json({ status: 'complete' });
		}

		return Response.json({ status, error });
	} catch (err) {
		logError('WORKFLOW-STATUS', 'Failed to get workflow status', { instanceId, error: String(err) });
		return Response.json({ status: 'error', error: String(err) }, { status: 404 });
	}
}

export async function handleWorkflowStream(instanceId: string, env: Env): Promise<Response> {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();

	const writeEvent = (data: object) => writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

	(async () => {
		try {
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 3000));

				const instance = await env.MONITOR_WORKFLOW.get(instanceId);
				const { status, output, error } = await instance.status();
				const isTerminal = status === 'complete' || status === 'errored' || status === 'terminated';

				if (status === 'complete') {
					const articleId = (output as Record<string, unknown> | undefined)?.article_id as string | undefined;
					if (articleId) {
						const db = await createDbClient(env);
						try {
							const table = ARTICLES_TABLE;
							const result = await db.query(`SELECT ${ARTICLE_FIELDS} FROM ${table} WHERE id = $1`, [articleId]);
							const article = result.rows[0];
							await writeEvent({ status: 'complete', article });
						} finally {
							await db.end();
						}
					} else {
						await writeEvent({ status: 'complete' });
					}
					return;
				}

				await writeEvent({ status, error });
				if (isTerminal) return;
			}
		} catch (err) {
			await writeEvent({ status: 'error', error: String(err) });
		} finally {
			await writer.close();
		}
	})();

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}
