export async function sendMessageToTelegram(token: string, chatId: string, message: string, options?: Record<string, any>) {
	const url = `https://api.telegram.org/bot${token}/sendMessage`;

	const body: any = {
		chat_id: chatId,
		text: message,
		...options,
	};

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error('[TELEGRAM] Error sending message:', response.status, response.statusText, errorText);
		}
	} catch (error) {
		console.error('[TELEGRAM] Error sending message:', error);
	}
}
