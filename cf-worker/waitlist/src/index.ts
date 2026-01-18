interface Env {
	APP_URL: string;
	CRON_SECRET: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return new Response('Waitlist Cron Worker - Use scheduled triggers');
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(processWaitlist(env));
	},
} satisfies ExportedHandler<Env>;

async function processWaitlist(env: Env): Promise<void> {
	const url = `${env.APP_URL}/api/cron/process-waitlist`;

	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.CRON_SECRET}`,
			'Content-Type': 'application/json',
		},
	});

	if (!response.ok) {
		console.error(`Failed to process waitlist: ${response.status} ${response.statusText}`);
		const text = await response.text();
		console.error(`Response: ${text}`);
		return;
	}

	const result = (await response.json()) as { expired: number; approved: number; message: string };
	console.log(`Waitlist processed: ${result.message}`);
}
