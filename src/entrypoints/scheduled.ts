import { handleRetryCron } from '../app/monitors/retry';
import { logInfo } from '../infra/log';
import type { Env, ExecutionContext, ScheduledEvent } from '../models/types';
import { handleBilibiliCron } from '../platforms/bilibili/monitor';
import { handleRSSCron } from '../platforms/rss/monitor';
import { handleTwitterCron } from '../platforms/twitter/monitor';
import { handleXiaohongshuCron } from '../platforms/xiaohongshu/monitor';
import { handleYouTubeCron } from '../platforms/youtube/monitor';

export function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): void {
	logInfo('CORE', 'Scheduled', { cron: event.cron });

	if (event.cron === '*/5 * * * *') {
		ctx.waitUntil(handleRSSCron(env, ctx));
	} else if (event.cron === '0 */6 * * *') {
		ctx.waitUntil(handleTwitterCron(env, ctx));
	} else if (event.cron === '*/30 * * * *') {
		ctx.waitUntil(handleYouTubeCron(env, ctx));
		ctx.waitUntil(handleBilibiliCron(env, ctx));
		ctx.waitUntil(handleXiaohongshuCron(env, ctx));
	} else if (event.cron === '0 3 * * *') {
		ctx.waitUntil(handleRetryCron(env, ctx));
	}
}
