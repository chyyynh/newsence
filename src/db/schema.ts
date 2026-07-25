import {
	RESOURCE_CATEGORIES,
	RESOURCE_SCOPES,
	RESOURCE_TRANSLATION_SOURCES,
	RESOURCE_TYPES,
	SOURCE_ACQUISITION_MODES,
	SOURCE_KINDS,
	SOURCE_PLATFORMS,
	SOURCE_STATUSES,
} from '@core-shared/resource-types';
import type { TranscriptSegment } from '@core-shared/types';
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from 'drizzle-orm/pg-core';

export const resources = pgTable(
	'resources',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
		type: text('type', { enum: RESOURCE_TYPES }).default('web').notNull(),
		scope: text('scope', { enum: RESOURCE_SCOPES }).default('private').notNull(),
		url: text('url'),
		normalizedUrl: text('normalized_url'),
		storageKey: text('storage_key').unique(),
		fileType: text('file_type'),
		contentHash: varchar('content_hash', { length: 64 }),
		originalLang: varchar('original_lang', { length: 35 }).default('en').notNull(),
		publishedDate: timestamp('published_date', { mode: 'date' }),
		scrapedDate: timestamp('scraped_date', { mode: 'date' }),
		tags: text('tags').array().default([]).notNull(),
		category: text('category', { enum: RESOURCE_CATEGORIES }),
		ogImageUrl: text('og_image_url'),
		platformMetadata: jsonb('platform_metadata').$type<unknown>(),
		enrichmentStatus: text('enrichment_status', { enum: ['pending', 'enriched', 'failed'] })
			.default('pending')
			.notNull(),
		createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
	},
	(table) => [
		index('resources_original_lang_idx').on(table.originalLang),
		index('resources_published_date_id_idx').on(table.publishedDate, table.id),
	],
);

export const resourceTranslations = pgTable(
	'resource_translations',
	{
		resourceId: uuid('resource_id')
			.notNull()
			.references(() => resources.id, { onDelete: 'cascade' }),
		lang: varchar('lang', { length: 35 }).notNull(),
		title: text('title'),
		summary: text('summary'),
		content: text('content'),
		keywords: text('keywords').array().default([]).notNull(),
		source: varchar('source', { length: 16, enum: RESOURCE_TRANSLATION_SOURCES }).default('original').notNull(),
		createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.resourceId, table.lang] }),
		index('resource_translations_lang_idx').on(table.lang),
		index('resource_translations_source_idx').on(table.source),
	],
);

export const library = pgTable(
	'library',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userId: text('user_id').notNull(),
		resourceId: uuid('resource_id')
			.notNull()
			.references(() => resources.id, { onDelete: 'cascade' }),
		originType: text('origin_type', { enum: ['saved_url', 'upload', 'generated'] }).notNull(),
		savedAt: timestamp('saved_at', { mode: 'date' }).defaultNow().notNull(),
		visibility: text('visibility', { enum: ['public', 'private'] })
			.default('private')
			.notNull(),
		note: text('note'),
		state: jsonb('state').$type<unknown>(),
		createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex('library_user_id_resource_id_key').on(table.userId, table.resourceId),
		index('library_resource_id_idx').on(table.resourceId),
		index('library_user_id_saved_at_idx').on(table.userId, table.savedAt),
	],
);

// Expand-only v2 mirrors (#240). Core reads these only after the app has
// deployed dual-writes and the production backfill has reconciled.
export const resourceSaves = pgTable(
	'resource_saves',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userId: text('user_id').notNull(),
		resourceId: uuid('resource_id')
			.notNull()
			.references(() => resources.id, { onDelete: 'cascade' }),
		visibility: varchar('visibility', { length: 16 }).default('private').notNull(),
		savedAt: timestamp('saved_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
		createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex('resource_saves_user_id_resource_id_key').on(table.userId, table.resourceId),
		index('resource_saves_resource_id_idx').on(table.resourceId),
		index('resource_saves_user_id_saved_at_id_idx').on(table.userId, table.savedAt.desc(), table.id.desc()),
	],
);

export const userFiles = pgTable(
	'user_files',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userId: text('user_id').notNull(),
		resourceId: uuid('resource_id')
			.notNull()
			.references(() => resources.id, { onDelete: 'cascade' })
			.unique(),
		kind: varchar('kind', { length: 16 }).notNull(),
		originalFileName: text('original_file_name').notNull(),
		byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
		createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index('user_files_user_id_created_at_idx').on(table.userId, table.createdAt)],
);

export const sources = pgTable(
	'sources',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		platform: text('platform', { enum: SOURCE_PLATFORMS }).notNull(),
		handle: text('handle').notNull(),
		name: text('name').notNull(),
		siteUrl: text('site_url'),
		avatarUrl: text('avatar_url'),
		category: text('category'),
		kind: text('kind', { enum: SOURCE_KINDS }).default('blog').notNull(),
		displayGroup: text('display_group'),
		acquisitionMode: text('content_mode', { enum: SOURCE_ACQUISITION_MODES }).notNull(),
		monitoringEnabled: boolean('enabled').default(true).notNull(),
		curated: boolean('curated').default(false).notNull(),
		createdBy: text('created_by'),
		status: text('status', { enum: SOURCE_STATUSES }).default('active').notNull(),
		scrapedAt: timestamp('scraped_at', { mode: 'date' }),
		scrapeState: jsonb('scrape_state').$type<unknown>(),
		createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex('sources_platform_handle_key').on(table.platform, table.handle)],
);

export const youtubeTranscripts = pgTable('youtube_transcripts', {
	id: uuid('id').defaultRandom().primaryKey(),
	videoId: text('video_id').notNull().unique(),
	transcript: jsonb('transcript').$type<TranscriptSegment[]>().notNull(),
	language: varchar('language', { length: 10 }),
	chapters: jsonb('chapters').$type<unknown[]>().notNull(),
	chaptersFromDescription: boolean('chapters_from_description').notNull(),
	fetchedAt: timestamp('fetched_at', { mode: 'date' }).notNull(),
	aiHighlights: jsonb('ai_highlights').$type<unknown>(),
	highlightsGeneratedAt: timestamp('highlights_generated_at', { mode: 'date' }),
});

export const entities = pgTable('entities', {
	id: uuid('id').defaultRandom().primaryKey(),
	canonicalName: varchar('canonical_name', { length: 255 }).notNull().unique(),
	name: varchar('name', { length: 255 }).notNull(),
	type: varchar('type', { length: 20 }).notNull(),
	resourceCount: integer('resource_count').default(0).notNull(),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const entityTranslations = pgTable(
	'entity_translations',
	{
		entityId: uuid('entity_id')
			.notNull()
			.references(() => entities.id, { onDelete: 'cascade' }),
		lang: varchar('lang', { length: 35 }).notNull(),
		name: varchar('name', { length: 255 }).notNull(),
		source: varchar('source', { length: 16, enum: RESOURCE_TRANSLATION_SOURCES }).default('original').notNull(),
		createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.entityId, table.lang] }),
		index('entity_translations_lang_idx').on(table.lang),
		index('entity_translations_source_idx').on(table.source),
	],
);

export const resourceEntities = pgTable(
	'resource_entities',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		resourceId: uuid('resource_id')
			.notNull()
			.references(() => resources.id, { onDelete: 'cascade' }),
		entityId: uuid('entity_id')
			.notNull()
			.references(() => entities.id, { onDelete: 'cascade' }),
	},
	(table) => [
		uniqueIndex('resource_entities_resource_id_entity_id_key').on(table.resourceId, table.entityId),
		index('resource_entities_entity_id_idx').on(table.entityId),
	],
);

export const collections = pgTable('collections', {
	id: uuid('id').defaultRandom().primaryKey(),
	userId: text('user_id'),
	name: varchar('name', { length: 100 }).notNull(),
	description: varchar('description', { length: 500 }),
	visibility: text('visibility').notNull(),
	resourceCount: integer('resource_count').default(0).notNull(),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const workspaces = pgTable('workspaces', {
	id: uuid('id').defaultRandom().primaryKey(),
	userId: text('user_id').notNull(),
	title: varchar('title', { length: 120 }).notNull(),
	description: varchar('description', { length: 500 }),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const collectionResources = pgTable(
	'collection_resources',
	{
		collectionId: uuid('collection_id')
			.notNull()
			.references(() => collections.id, { onDelete: 'cascade' }),
		resourceId: uuid('resource_id')
			.notNull()
			.references(() => resources.id, { onDelete: 'cascade' }),
		addedAt: timestamp('added_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.collectionId, table.resourceId] }),
		index('collection_resources_resource_id_idx').on(table.resourceId),
		index('collection_resources_collection_id_added_at_idx').on(table.collectionId, table.addedAt),
	],
);

export const workspaceResources = pgTable(
	'workspace_resources',
	{
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		resourceId: uuid('resource_id')
			.notNull()
			.references(() => resources.id, { onDelete: 'cascade' }),
		addedAt: timestamp('added_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.workspaceId, table.resourceId] }),
		index('workspace_resources_resource_id_idx').on(table.resourceId),
		index('workspace_resources_workspace_id_added_at_idx').on(table.workspaceId, table.addedAt),
	],
);

export const workspaceCollections = pgTable(
	'workspace_collections',
	{
		workspaceId: uuid('workspace_id')
			.notNull()
			.references(() => workspaces.id, { onDelete: 'cascade' }),
		collectionId: uuid('collection_id')
			.notNull()
			.references(() => collections.id, { onDelete: 'cascade' }),
		pinnedAt: timestamp('pinned_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.workspaceId, table.collectionId] }),
		index('workspace_collections_collection_id_idx').on(table.collectionId),
		index('workspace_collections_workspace_id_pinned_at_idx').on(table.workspaceId, table.pinnedAt),
	],
);
