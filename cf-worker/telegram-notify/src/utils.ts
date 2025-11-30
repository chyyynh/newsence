export async function sendMessageToTelegram(token: string, chatId: string, message: string) {
	console.log('Debug sendMessageToTelegram - Token:', token ? `${token.substring(0, 20)}...` : 'MISSING');
	console.log('Debug sendMessageToTelegram - Chat ID:', chatId);
	console.log('Debug sendMessageToTelegram - Message length:', message.length);
	
	const url = `https://api.telegram.org/bot${token}/sendMessage`;
	const body = JSON.stringify({
		chat_id: chatId,
		text: message,
		parse_mode: 'Markdown',
	});

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body,
		});

		if (!response.ok) {
			const errorBody = await response.text(); // Get the response body for detailed error
			if (response.status === 401) {
				console.warn(`User ${chatId} hasn't started conversation with bot (401 Unauthorized)`);
			} else {
				console.error('Error sending message to Telegram:', response.status, response.statusText, 'Body:', errorBody);
			}
			throw new Error(`Telegram API Error: ${response.status} ${response.statusText} - ${errorBody}`);
		}
	} catch (error) {
		console.error('Error sending message to Telegram:', error);
		// Re-throw the error so the caller can handle it if needed
		throw error;
	}
}

// --- New AI Summarization Utility Function ---

// Define a simple structure for articles expected by the summarizer
interface ArticleForSummary {
	title: string;
	url: string;
	source: string;
	tags?: {
		category?: string;
		coins?: string[];
	};
}

// OpenRouter API response types
interface OpenRouterMessage {
	role: string;
	content: string;
}

interface OpenRouterChoice {
	message: OpenRouterMessage;
	finish_reason: string;
	index: number;
}

interface OpenRouterResponse {
	choices: OpenRouterChoice[];
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export async function summarizeWithOpenRouter(apiKey: string, articles: ArticleForSummary[]): Promise<string> {
	try {
		// Prepare the prompt using the structured data
		let articlesForPrompt = '';
		// Group by category for better structure in the prompt
		const categories: { [key: string]: ArticleForSummary[] } = {};
		articles.forEach((article) => {
			const category = article.tags?.category || '其他';
			if (!categories[category]) categories[category] = [];
			categories[category].push(article);
		});

		for (const [category, items] of Object.entries(categories)) {
			articlesForPrompt += `【${category}】\n`;
			items.forEach((item) => {
				articlesForPrompt += `- ${item.source}: ${item.title}\n  ${item.url}\n`;
			});
			articlesForPrompt += '\n';
		}

		// --- Construct Prompt ---
		const prompt = `请根据以下 AI 新闻文章列表，产生一份简洁的中文摘要报告。 
			目标是总结每则新闻成一句标题，并依照重要性1-10分打分和排序，并附上连结。 
			请使用 Telegram Markdown 语法格式，这是 Telegram 频道讯息直接使用，不会再整理，请勿输出无关资讯。避免使用反引号和三个反引号。 

			标准：
			- 9-10 分：新产品发布、重大行业影响或商业模式变革、大型融资
			- 7-8 分：技术突破、重要商业合作趣味应用、小规模创新、中型融资
			- 5-6 分：实用工具或中型融资
			- 3-4 分：小规模创新、实用工具、趣味应用
			- 1-2 分：评论、边缘话题或纯展示项目

			范例格式：
			---
			1. (新产品) **Meta推出手势控制腕带利用AI解读肌肉信号** (10/10) - [link](https://newslink)
			2. (产品更新) **Grok推出新App连接器提升生产力** (7/10) - [link](https://newslink)
			3. (评论) **a16z：AI行业正处于扩张阶段需积极投资** (3/10) - [link](https://newslink)
			---

			新闻列表：
			---
			${articlesForPrompt}
			---`;
		console.log('Using default summary prompt.');

		console.log('Sending request to OpenRouter API via utils...');
		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: 'deepseek/deepseek-chat',
				messages: [{ role: 'user', content: prompt }],
				temperature: 0.7,
				max_tokens: 1024,
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`OpenRouter API Error: ${response.status} ${response.statusText} - ${errorBody}`);
		}

		const data: OpenRouterResponse = await response.json();
		console.log('OpenRouter API Response:', JSON.stringify(data, null, 2));
		
		if (!data.choices || !data.choices[0] || !data.choices[0].message) {
			throw new Error('OpenRouter API Error: No response received.');
		}

		const summary = data.choices[0].message.content;
		console.log('OpenRouter Summary Received via utils (length):', summary?.length || 0);
		console.log('OpenRouter Summary Content (first 500 chars):', summary?.substring(0, 500));

		if (!summary || summary.trim().length === 0) {
			throw new Error('OpenRouter API returned empty summary');
		}

		if (summary.length > 4096) {
			console.warn(`OpenRouter summary exceeded 4096 chars (${summary.length}). Returning truncated version.`);
			return summary.substring(0, 4096);
		}

		return summary;
	} catch (error) {
		console.error('Error during AI summarization in utils:', error);
		// Re-throw the error to be handled by the main scheduled function
		throw error;
	}
}
