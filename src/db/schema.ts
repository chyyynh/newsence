import type { TranscriptSegment } from '@core-shared/types';
import { bigint, boolean, customType, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

const vector1024 = customType<{ data: string; driverData: string }>({
	dataType() {
		return 'vector(1024)';
	},
});

const tsvector = customType<{ data: string; driverData: string }>({
	dataType() {
		return 'tsvector';
	},
});

export const articles = pgTable('articles', {
	id: uuid('id').defaultRandom().primaryKey(),
	url: text('url').notNull().unique(),
	title: text('title').notNull(),
	titleCn: text('title_cn'),
	summary: text('summary'),
	summaryCn: text('summary_cn'),
	content: text('content'),
	contentCn: text('content_cn'),
	ogImageUrl: text('og_image_url'),
	source: text('source').notNull(),
	sourceType: text('source_type').notNull(),
	publishedDate: timestamp('published_date', { mode: 'date' }).notNull(),
	scrapedDate: timestamp('scraped_date', { mode: 'date' }).notNull(),
	tags: text('tags').array().notNull(),
	keywords: text('keywords').array().notNull(),
	tokens: text('tokens').array().notNull(),
	platformMetadata: jsonb('platform_metadata').$type<unknown>(),
	entities: jsonb('entities').$type<unknown>(),
	embedding: vector1024('embedding'),
});

export const userFiles = pgTable('user_files', {
	id: uuid('id').primaryKey(),
	userId: text('user_id'),
	fileName: text('file_name').notNull(),
	fileType: text('file_type').notNull(),
	storageKey: text('storage_key'),
	title: text('title'),
	titleCn: text('title_cn'),
	summary: text('summary'),
	summaryCn: text('summary_cn'),
	extractedText: text('extracted_text'),
	contentCn: text('content_cn'),
	ogImageUrl: text('og_image_url'),
	sourceUrl: text('source_url'),
	normalizedSourceUrl: text('normalized_source_url'),
	siteName: text('site_name'),
	platformType: text('platform_type'),
	resourceKind: text('resource_kind').notNull(),
	originType: text('origin_type').notNull(),
	publishedDate: timestamp('published_date', { mode: 'date' }),
	tags: text('tags').array().notNull(),
	keywords: text('keywords').array().notNull(),
	metadata: jsonb('metadata').$type<unknown>(),
	entities: jsonb('entities').$type<unknown>(),
	embedding: vector1024('embedding'),
});

export const resources = pgTable('resources', {
	id: uuid('id').defaultRandom().primaryKey(),
	type: text('type').default('web').notNull(),
	scope: text('scope', { enum: ['corpus', 'private'] })
		.default('private')
		.notNull(),
	url: text('url'),
	normalizedUrl: text('normalized_url'),
	storageKey: text('storage_key').unique(),
	fileType: text('file_type'),
	title: text('title'),
	titleCn: text('title_cn'),
	summary: text('summary'),
	summaryCn: text('summary_cn'),
	content: text('content'),
	contentCn: text('content_cn'),
	source: text('source'),
	publishedDate: timestamp('published_date', { mode: 'date' }),
	scrapedDate: timestamp('scraped_date', { mode: 'date' }),
	keywords: text('keywords').array().default([]).notNull(),
	tags: text('tags').array().default([]).notNull(),
	entities: jsonb('entities').$type<unknown>(),
	ogImageUrl: text('og_image_url'),
	platformMetadata: jsonb('platform_metadata').$type<unknown>(),
	searchVector: tsvector('search_vector'),
	embedding: vector1024('embedding'),
	enrichmentStatus: text('enrichment_status', { enum: ['pending', 'enriched', 'failed'] })
		.default('pending')
		.notNull(),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const library = pgTable('library', {
	id: uuid('id').defaultRandom().primaryKey(),
	userId: text('user_id').notNull(),
	resourceId: uuid('resource_id').notNull(),
	originType: text('origin_type', { enum: ['saved_url', 'upload', 'generated'] }).notNull(),
	savedAt: timestamp('saved_at', { mode: 'date' }).defaultNow().notNull(),
	visibility: text('visibility', { enum: ['public', 'private'] })
		.default('private')
		.notNull(),
	note: text('note'),
	state: jsonb('state').$type<unknown>(),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const rssList = pgTable('RssList', {
	id: bigint('id', { mode: 'number' }).primaryKey(),
	name: text('name').notNull(),
	rssLink: text('RSSLink'),
	type: text('type').notNull(),
	isDefault: boolean('is_default').notNull(),
	scrapedAt: timestamp('scraped_at', { mode: 'date' }).notNull(),
});

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
	nameCn: varchar('name_cn', { length: 255 }),
	type: varchar('type', { length: 20 }).notNull(),
	articleCount: integer('article_count').default(0).notNull(),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const articleEntities = pgTable('article_entities', {
	id: uuid('id').defaultRandom().primaryKey(),
	articleId: uuid('article_id').notNull(),
	entityId: uuid('entity_id').notNull(),
});

export const resourceEntities = pgTable('resource_entities', {
	id: uuid('id').defaultRandom().primaryKey(),
	resourceId: uuid('resource_id').notNull(),
	entityId: uuid('entity_id').notNull(),
});

export const papers = pgTable('papers', {
	id: uuid('id').defaultRandom().primaryKey(),
	openAlexId: varchar('openalex_id', { length: 32 }).notNull().unique(),
	doi: text('doi').unique(),
	articleId: uuid('article_id'),
	title: text('title'),
	authors: text('authors').array().notNull(),
	venue: text('venue'),
	year: integer('year'),
	abstract: text('abstract'),
	citedByCount: integer('cited_by_count'),
	oaPdfUrl: text('oa_pdf_url'),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const paperReferences = pgTable('paper_references', {
	id: uuid('id').defaultRandom().primaryKey(),
	fromPaperId: uuid('from_paper_id').notNull(),
	toPaperId: uuid('to_paper_id').notNull(),
	ordinal: integer('ordinal'),
});

export const collections = pgTable('collections', {
	id: uuid('id').defaultRandom().primaryKey(),
	userId: text('user_id'),
	name: varchar('name', { length: 100 }).notNull(),
	description: varchar('description', { length: 500 }),
	visibility: text('visibility').notNull(),
	articleCount: integer('article_count').default(0).notNull(),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});

export const citations = pgTable('citations', {
	id: uuid('id').defaultRandom().primaryKey(),
	fromType: text('from_type').notNull(),
	fromId: text('from_id').notNull(),
	toType: text('to_type').notNull(),
	toId: uuid('to_id').notNull(),
	userId: text('user_id').notNull(),
	createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
	updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
});
