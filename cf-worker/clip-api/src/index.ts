import { Container, getContainer } from '@cloudflare/containers';
import { Hono } from 'hono';

// ── Durable Object: job lifecycle in SQLite, container is stateless ──

interface JobRow {
	id: string;
	params: string;
	status: string;
	result: string | null;
	created_at: number;
}

export class ClipContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = '5m';
	override envVars = {
		R2_ACCOUNT_ID: this.env.R2_ACCOUNT_ID,
		R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
		R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
		R2_BUCKET: this.env.R2_BUCKET || 'newsence',
		R2_PUBLIC_URL: this.env.R2_PUBLIC_URL,
		PORT: '8080',
	};

	private schemaReady = false;

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY,
				params TEXT NOT NULL,
				status TEXT DEFAULT 'submitted',
				result TEXT,
				created_at INTEGER DEFAULT (unixepoch())
			)
		`);
		// Purge old jobs (> 7 days)
		this.ctx.storage.sql.exec('DELETE FROM jobs WHERE created_at < unixepoch() - 604800');
		this.schemaReady = true;
	}

	// Re-dispatch orphaned jobs after container restart/deploy
	override async onStart(): Promise<void> {
		this.ensureSchema();
		const orphaned = [...this.ctx.storage.sql.exec("SELECT id, params FROM jobs WHERE status = 'submitted'")] as unknown as JobRow[];

		const dispatches: Promise<void>[] = [];
		for (const job of orphaned) {
			try {
				const params = JSON.parse(job.params);
				dispatches.push(
					this.containerFetch('http://localhost/clip', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ ...params, jobId: job.id }),
					})
						.then(() => {})
						.catch((err) => console.error(`[DO] Re-dispatch ${job.id} failed:`, err)),
				);
			} catch (err) {
				console.error(`[DO] Parse params for ${job.id} failed:`, err);
			}
		}
		await Promise.allSettled(dispatches);
	}

	// Persist terminal states from container so job lifecycle doesn't depend on client polling
	private async syncSubmittedJobs(): Promise<void> {
		const submitted = [...this.ctx.storage.sql.exec("SELECT id FROM jobs WHERE status = 'submitted'")] as unknown as JobRow[];
		for (const job of submitted) {
			try {
				const res = await this.containerFetch(`http://localhost/clip/${job.id}`);
				if (res.status !== 200) continue;
				const data = (await res.json()) as Record<string, unknown>;
				if (data.status === 'done' || data.status === 'error') {
					this.ctx.storage.sql.exec(
						'UPDATE jobs SET status = ?, result = ? WHERE id = ?',
						String(data.status),
						JSON.stringify(data),
						job.id,
					);
				}
			} catch {
				// Container not reachable — leave as submitted for onStart recovery
			}
		}
	}

	// Prevent sleep while jobs are in-flight
	override async onActivityExpired(): Promise<void> {
		this.ensureSchema();
		await this.syncSubmittedJobs();
		const rows = [...this.ctx.storage.sql.exec("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'submitted'")];
		if (Number((rows[0] as Record<string, unknown>)?.cnt ?? 0) > 0) {
			this.renewActivityTimeout();
			return;
		}
		await this.stop();
	}

	override async fetch(request: Request): Promise<Response> {
		this.ensureSchema();
		const url = new URL(request.url);

		// POST /clip — track in SQLite, forward to container
		if (request.method === 'POST' && url.pathname === '/clip') {
			return this.handlePostClip(request);
		}

		// GET /clip/:id — try container first, fallback to SQLite
		if (request.method === 'GET' && url.pathname.startsWith('/clip/') && url.pathname.split('/').filter(Boolean).length === 2) {
			return this.handleGetClip(request);
		}

		// Forward everything else (health, etc.) to container
		return super.fetch(request);
	}

	private async handlePostClip(request: Request): Promise<Response> {
		const body = (await request.json()) as Record<string, unknown>;

		// Forward to container
		const containerRes = await this.containerFetch('http://localhost/clip', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		const data = (await containerRes.json()) as Record<string, unknown>;

		// Track job in SQLite
		if (data.jobId) {
			this.ctx.storage.sql.exec('INSERT OR IGNORE INTO jobs (id, params) VALUES (?, ?)', String(data.jobId), JSON.stringify(body));
		}

		return Response.json(data, { status: containerRes.status });
	}

	private async handleGetClip(request: Request): Promise<Response> {
		const jobId = new URL(request.url).pathname.split('/').pop()!;

		// Ask container for live status
		try {
			const containerRes = await this.containerFetch(`http://localhost/clip/${jobId}`);
			const data = (await containerRes.json()) as Record<string, unknown>;

			if (containerRes.status === 200) {
				// Persist terminal states to SQLite
				if (data.status === 'done' || data.status === 'error') {
					this.ctx.storage.sql.exec(
						'UPDATE jobs SET status = ?, result = ? WHERE id = ?',
						String(data.status),
						JSON.stringify(data),
						jobId,
					);
				}
				return Response.json(data);
			}

			// Container says "not found" — check SQLite for recovery
			if (containerRes.status === 404) {
				return this.recoverJob(jobId);
			}

			return Response.json(data, { status: containerRes.status });
		} catch {
			// Container might not be running yet (cold start)
			return this.recoverJob(jobId);
		}
	}

	private recoverJob(jobId: string): Response {
		const rows = [...this.ctx.storage.sql.exec('SELECT * FROM jobs WHERE id = ?', jobId)] as unknown as JobRow[];

		if (rows.length === 0) {
			return Response.json({ error: 'Job not found' }, { status: 404 });
		}

		const tracked = rows[0];

		// Completed before crash — return saved result
		if (tracked.result && tracked.status !== 'submitted') {
			return new Response(tracked.result, {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Job was in-flight — will be re-dispatched by onStart()
		const params = JSON.parse(tracked.params) as Record<string, unknown>;
		return Response.json({
			status: 'queued',
			videoId: params.videoId,
			startTime: params.startTime,
			endTime: params.endTime,
			createdAt: tracked.created_at * 1000,
		});
	}
}

// ── Worker entry point (auth + routing to DO) ───────────────

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));

function checkAuth(c: { req: { header: (name: string) => string | undefined }; env: Env }) {
	const auth = c.req.header('Authorization');
	if (!auth || auth !== `Bearer ${c.env.CLIP_API_SECRET}`) {
		return false;
	}
	return true;
}

app.post('/clip', async (c) => {
	if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
	const container = getContainer(c.env.CLIP_CONTAINER);
	return await container.fetch(c.req.raw);
});

app.get('/clip/:jobId', async (c) => {
	if (!checkAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
	const container = getContainer(c.env.CLIP_CONTAINER);
	return await container.fetch(c.req.raw);
});

export default app;
