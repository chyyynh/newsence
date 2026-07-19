import type { ResourceMediaRpc } from '@app-domain/resource-media-contracts';

declare global {
	type CoreEnv = Omit<BaseCoreEnv, 'DOMAIN'> & {
		DOMAIN: BaseCoreEnv['DOMAIN'] & ResourceMediaRpc;
	};
}
