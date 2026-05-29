// MIRROR OF frontend/src/types/context.ts. Worker only reads
// `id | type | title | articleCount` (see `buildUnifiedContext` in
// lib/ai/prompts.ts), so the `article` payload is round-tripped opaquely
// and not structurally validated here. Keep field names + the discriminator
// `type` literal aligned with the frontend so request bodies parse cleanly
// on either surface.

import { z } from 'zod';

export const CONTEXT_ITEM_TYPES = ['article', 'document', 'collection'] as const;
export type ContextItemType = (typeof CONTEXT_ITEM_TYPES)[number];

const baseContextFields = {
	id: z.string(),
	title: z.string(),
	titleCn: z.string().nullable().optional(),
};

export const ArticleContextItemSchema = z.object({
	...baseContextFields,
	type: z.literal('article'),
	// Opaque payload — client serialises an ArticleItem here, server passes through.
	article: z.unknown(),
});

export const DocumentContextItemSchema = z.object({
	...baseContextFields,
	type: z.literal('document'),
});

export const CollectionContextItemSchema = z.object({
	...baseContextFields,
	type: z.literal('collection'),
	articleCount: z.number(),
});

export const ContextItemSchema = z.discriminatedUnion('type', [
	ArticleContextItemSchema,
	DocumentContextItemSchema,
	CollectionContextItemSchema,
]);

export type ArticleContextItem = z.infer<typeof ArticleContextItemSchema>;
export type DocumentContextItem = z.infer<typeof DocumentContextItemSchema>;
export type CollectionContextItem = z.infer<typeof CollectionContextItemSchema>;
export type ContextItem = z.infer<typeof ContextItemSchema>;
