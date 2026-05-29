// MIRROR OF frontend/src/lib/config/models.ts pricing fields.
// Keep input/output rates and aliases in sync on model adds or price changes.
// Worker uses plain numbers instead of Prisma.Decimal — Postgres numeric(10,6)
// parses floats fine and accumulation is single-digit USD per session.

export interface TextPricing {
	/** USD per 1M input tokens */
	inputPerMillion: number;
	/** USD per 1M output tokens */
	outputPerMillion: number;
}

export interface ImagePricing {
	/** USD per generated image */
	perImage: number;
}

const MODEL_ID_ALIASES: Record<string, string> = {
	'gemini-3.1-pro': 'google/gemini-3.1-pro-preview',
	'gemini-3.1-flash-lite': 'google/gemini-3.1-flash-lite-preview',
	'claude-sonnet': 'anthropic/claude-sonnet-4-6',
	'claude-opus': 'anthropic/claude-opus-4-6',
	'gpt-5.4': 'openai/gpt-5.4',
};

const TEXT_PRICING: Record<string, TextPricing> = {
	'google/gemini-3.1-pro-preview': { inputPerMillion: 2.0, outputPerMillion: 12.0 },
	'google/gemini-3.1-flash-lite-preview': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
	'google/gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
	'anthropic/claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
	'anthropic/claude-opus-4-6': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
	'openai/gpt-5.4': { inputPerMillion: 1.75, outputPerMillion: 14.0 },
};

// USD per image. Mirrors modelConfigs[...].pricing.image in
// frontend/src/lib/config/models.ts — keep in sync on price changes.
const IMAGE_PRICING: Record<string, ImagePricing> = {
	'google/gemini-3-pro-image-preview': { perImage: 0.2 },
};

export function resolveModelId(modelId: string): string {
	return MODEL_ID_ALIASES[modelId] ?? modelId;
}

export function getTextPricing(modelId: string): TextPricing {
	const id = resolveModelId(modelId);
	const pricing = TEXT_PRICING[id];
	if (!pricing) throw new Error(`Unknown model "${modelId}" — not registered in worker pricing table`);
	return pricing;
}

export function calculateTextCost(modelId: string, inputTokens: number, outputTokens: number): number {
	const { inputPerMillion, outputPerMillion } = getTextPricing(modelId);
	return (inputTokens / 1_000_000) * inputPerMillion + (outputTokens / 1_000_000) * outputPerMillion;
}

export function getImagePricing(modelId: string): ImagePricing {
	const id = resolveModelId(modelId);
	const pricing = IMAGE_PRICING[id];
	if (!pricing) throw new Error(`Unknown image model "${modelId}" — not registered in worker pricing table`);
	return pricing;
}

export function calculateImageCost(modelId: string, count = 1): number {
	return getImagePricing(modelId).perImage * count;
}
