// Public service facade for the media domain — the ONLY module other domains
// (e.g. @chat) should import from @media. Args/returns serializable so this
// promotes to a WorkerEntrypoint RPC method when chat splits into its own
// worker. Billing stays with the caller (chat); this is purely generation+storage.

import type { Env } from '@shared/types';
import { IMAGE_MODEL, runGenerateImage } from './generate-image';

export { IMAGE_MODEL };

export interface GeneratedImage {
	assetUrl: string;
	/** Model used — lets the caller attribute billing without duplicating the constant. */
	model: string;
}

/** Generate an AI illustration, store it in R2 + user_files, and return its asset URL. */
export async function generateImage(env: Env, userId: string, prompt: string): Promise<GeneratedImage> {
	const result = await runGenerateImage(env, userId, prompt);
	return { assetUrl: result.assetUrl, model: IMAGE_MODEL };
}
