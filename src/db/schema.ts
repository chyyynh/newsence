import type { TranscriptSegment } from '@core-shared/types';
import { bigint, boolean, customType, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

const vector1024 = customType<{ data: string; driverData: string }>({
	dataType() {
		return 'vector(1024)';
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
