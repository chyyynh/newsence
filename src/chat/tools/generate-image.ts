// Mirrors frontend/src/lib/ai/tools/generate-image.ts. Reuses the worker's
// own runGenerateImage primitive (same one /generate-image POSTs through).
// Billing is server-side and self-contained: a real-cost balance gate before
// spending the OpenRouter call, then an atomic credit deduction + Polar
// metering after a successful generation — no client round-trip to skip.

import { IMAGE_MODEL, runGenerateImage } from '@media/generate-image';
import type { Env } from '@shared/types';
import { tool } from 'ai';
import { z } from 'zod';
import { billing } from '../billing/server';

export type GenerateImageResult = { imageUrl: string };

export function createGenerateImageTool(env: Env, userId: string) {
	return tool({
		description:
			'Generate an AI illustration. Only use when explicitly asked. Costs credits — one call per response. ' +
			'Display the result with ![description](imageUrl). ' +
			'IMPORTANT: imageUrl is a relative path starting with /api/media/asset/ — use it exactly as returned, do NOT modify or prepend any domain.',
		inputSchema: z.object({
			prompt: z
				.string()
				.min(10)
				.describe('Narrative scene description (full sentences, not keyword lists). See system prompt for formula.'),
		}),
		execute: async ({ prompt }): Promise<GenerateImageResult> => {
			// Gate on the actual image cost (not a token of credit) before burning
			// the paid OpenRouter request. Throws QuotaExceededError → surfaced to
			// the model as a tool error so it can tell the user to upgrade.
			await billing.checkImage(env, userId, IMAGE_MODEL, 1);

			const result = await runGenerateImage(env, userId, prompt);

			// Deduct + meter after a successful generation. Never throws — a failed
			// deduction is logged, not surfaced (the pre-check already gated).
			await billing.trackImage(env, {
				userId,
				model: IMAGE_MODEL,
				count: 1,
				meta: { endpoint: 'tool/generate-image' },
			});

			return { imageUrl: result.assetUrl };
		},
	});
}
