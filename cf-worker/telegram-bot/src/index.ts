/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { createClient } from '@supabase/supabase-js';

interface Env {
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	TELEGRAM_BOT_TOKEN: string;
	GEMINI_API_KEY: string;
}

export default {
	async fetch(request: Request, env: any) {
		const payload = (await request.json()) as {
			message?: { text?: string; from: { id: number }; chat: { id: number } };
			callback_query?: { from: { id: number }; message: { chat: { id: number } }; data: string };
		};

		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

		// handle /start
		if (payload.message?.text === '/start') {
			console.log(payload);
			const user_telegram_id = payload.message.from.id;
			console.log(`user_telegram_id: ${user_telegram_id}\n`);

			// 查詢是否已存在該 telegram_id
			const { data: user, error: userError } = await supabase
				.from('user_preferences')
				.select('telegram_id')
				.eq('telegram_id', user_telegram_id)
				.single();

			if (userError && userError.code !== 'PGRST116') {
				console.error('Error checking user:', userError);
				return new Response('error', { status: 500 });
			}

			if (!user) {
				// 不存在，新增資料
				const { error: insertError } = await supabase.from('user_preferences').insert([
					{
						telegram_id: user_telegram_id,
					},
				]);

				if (insertError) {
					console.error('Error inserting user:', insertError);
					return new Response('error', { status: 500 });
				}
			}

			await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: user_telegram_id,
					text: '請選擇你感興趣的主題：',
					reply_markup: {
						inline_keyboard: [
							[{ text: 'Trump', callback_data: 'tag:trump' }],
							[{ text: 'DeFi', callback_data: 'tag:defi' }],
							[{ text: 'Funding', callback_data: 'tag:funding' }],
						],
					},
				}),
			});

			return new Response('ok');
		}

		if (payload.callback_query) {
			const user_telegram_id = payload.callback_query.from.id;

			const tag = payload.callback_query.data.replace('tag:', '');

			const { data: existing, error: selectError } = await supabase
				.from('user_preferences')
				.select('selected_tags')
				.eq('telegram_id', user_telegram_id)
				.single();

			if (selectError && selectError.code !== 'PGRST116') {
				// 非 "no rows returned" 的錯誤，處理錯誤
				console.error('Error selecting user:', selectError);
				return;
			}

			// 已存在，更新 subtags（合併新的 tag）
			if (existing) {
				const updatedSubtags = [...new Set([...existing.selected_tags, tag])];
				await supabase.from('user_preferences').update({ selected_tags: updatedSubtags }).eq('telegram_id', user_telegram_id);
			}

			// 回覆使用者
			await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: user_telegram_id,
					text: `你已訂閱「${tag}」新聞 ✅`,
				}),
			});

			return new Response('callback handled');
		}

		return new Response('ok');
	},
};
