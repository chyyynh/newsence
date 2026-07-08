import { fileURLToPath, URL } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??= 'postgresql://newsence:test@127.0.0.1:5432/newsence_test';

export default defineConfig({
	resolve: {
		alias: {
			'@core-ai': fileURLToPath(new URL('./src/ai', import.meta.url)),
			'@core-shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
			'@entities': fileURLToPath(new URL('./src/entities', import.meta.url)),
			'@ingest': fileURLToPath(new URL('./src/ingest', import.meta.url)),
			pg: fileURLToPath(new URL('./test/stubs/pg.ts', import.meta.url)),
		},
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			additionalExports: { NewsenceMonitorWorkflow: 'WorkflowEntrypoint' },
		}),
	],
	test: {
		include: ['test/**/*.smoke.test.ts'],
		testTimeout: 420_000,
		hookTimeout: 60_000,
	},
});
