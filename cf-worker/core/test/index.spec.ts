import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('core worker HTTP endpoints', () => {
	it('returns health status', async () => {
		const request = new IncomingRequest('http://example.com/health');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: 'ok', worker: 'newsence-core-test' });
	});

	it('returns worker status meta', async () => {
		const response = await SELF.fetch('https://example.com/status');
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.worker).toBe('newsence-core-test');
		expect(body.features).toContain('article-process');
	});

	it('falls back to default landing page', async () => {
		const response = await SELF.fetch('https://example.com/');
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('Newsence Core Worker');
	});
});
