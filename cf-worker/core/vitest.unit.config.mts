import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.spec.ts'],
		exclude: ['test/index.spec.ts'],
		environment: 'node',
	},
});
