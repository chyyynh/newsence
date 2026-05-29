export function logInfo(tag: string, msg: string, data?: Record<string, unknown>): void {
	// biome-ignore lint/suspicious/noConsole: structured logger entry point
	console.log(JSON.stringify({ tag, msg, ...data }));
}

export function logWarn(tag: string, msg: string, data?: Record<string, unknown>): void {
	console.warn(JSON.stringify({ tag, msg, ...data }));
}

export function logError(tag: string, msg: string, data?: Record<string, unknown>): void {
	console.error(JSON.stringify({ tag, msg, ...data }));
}
