// Mirrors frontend/src/lib/ai/tools/generate-image.ts. Reuses the worker's
// own runGenerateImage primitive (same one /generate-image POSTs through).
// Phase 6b billing model: cheap balance pre-check here, then a transient
// data-image-usage part so the frontend onFinish hits /track-image.

import { tool } from 'ai';
import { z } from 'zod';
import { IMAGE_MODEL, runGenerateImage } from '../../app/handlers/generate-image';
import { getCreditBalance } from '../../lib/billing/balance';
import type { Env } from '../../models/types';
import type { DataPartWriter } from './registry';

const MIN_CREDITS_PER_IMAGE = 1;

export type GenerateImageResult = { imageUrl: string };

export function createGenerateImageTool(env: Env, userId: string, writer?: DataPartWriter) {
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
			const balance = await getCreditBalance(env, userId);
			if (balance < MIN_CREDITS_PER_IMAGE) {
				throw new Error(`Insufficient credits (balance: ${balance}). Image generation requires ${MIN_CREDITS_PER_IMAGE} credit.`);
			}

			const result = await runGenerateImage(env, userId, prompt);

			writer?.write({
				type: 'data-image-usage',
				data: { model: IMAGE_MODEL, count: 1 },
				transient: true,
			});

			return { imageUrl: result.assetUrl };
		},
	});
}
