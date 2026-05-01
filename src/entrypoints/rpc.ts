import { type SubmitOutcome, submitUrls } from '../app/use-cases/submit-urls';
import type { Env } from '../models/types';

export type SubmitUrlRpcArgs = {
	url?: string;
	urls?: string[];
	userId?: string;
};

export function submitUrlRpc(env: Env, args: SubmitUrlRpcArgs): Promise<SubmitOutcome> {
	const urls = args.urls ?? (args.url ? [args.url] : []);
	return submitUrls(env, {
		urls,
		userId: args.userId,
		rateKey: args.userId ? `user:${args.userId}` : 'rpc:anon',
	});
}
