type MonitorHandler = (env: CoreEnv) => Promise<void>;

async function reconcileOfficialPublications(env: CoreEnv): Promise<void> {
	try {
		const result = await env.DOMAIN.reconcileOfficialPublications();
		console.info({
			tag: 'OFFICIAL_PUBLICATIONS',
			msg: 'Reconciled curated corpus publications',
			inserted: result.inserted,
		});
	} catch (error) {
		// Publication is derived product state. Never turn a repair failure into
		// an ingest failure; the next monitor cycle retries the same statement.
		console.error({
			tag: 'OFFICIAL_PUBLICATIONS',
			msg: 'Reconciliation failed; retrying next monitor cycle',
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function runMonitorCycle(env: CoreEnv, handler: MonitorHandler): Promise<void> {
	try {
		await handler(env);
	} finally {
		await reconcileOfficialPublications(env);
	}
}
