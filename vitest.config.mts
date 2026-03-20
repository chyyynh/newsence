import path from 'node:path';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Force Wrangler to use a local writable directory for logs/state during tests
process.env.WRANGLER_HOME = path.join(process.cwd(), '.wrangler');

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: {
					configPath: './wrangler.jsonc',
					isolatedStorage: false,
				},
				// Explicitly disable isolated storage flag to support Workflows in tests
				isolatedStorage: false,
			},
		},
	},
});
