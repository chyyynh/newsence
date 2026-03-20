import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.spec.ts'],
		exclude: ['test/index.spec.ts', 'test/rss-pipeline-e2e.spec.ts'],
		environment: 'node',
		passWithNoTests: true,
	},
});
