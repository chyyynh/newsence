import { fileURLToPath, URL } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??= 'postgresql://newsence:test@127.0.0.1:5432/newsence_test';
process.env.KAITO_API_KEY ??= 'test-kaito-api-key';
process.env.YOUTUBE_API_KEY ??= 'test-youtube-api-key';
process.env.S2_API_KEY ??= 'test-s2-api-key';

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
			miniflare: {
				bindings: {
					KAITO_API_KEY: 'test-kaito-api-key',
					YOUTUBE_API_KEY: 'test-youtube-api-key',
					S2_API_KEY: 'test-s2-api-key',
				},
			},
		}),
	],
	test: {
		include: ['test/**/*.test.ts'],
	},
});
