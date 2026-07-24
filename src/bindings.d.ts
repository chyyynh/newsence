import type { OfficialPublicationsRpc } from '@app-domain/official-publications-contracts';
import type { ResourceMediaRpc } from '@app-domain/resource-media-contracts';

declare global {
	type CoreEnv = Omit<BaseCoreEnv, 'DOMAIN'> & {
		DOMAIN: BaseCoreEnv['DOMAIN'] & OfficialPublicationsRpc & ResourceMediaRpc;
	};
}
