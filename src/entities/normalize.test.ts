/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ResourceForProcessing } from '@core-shared/types';
import { mergeResourceClassification } from '@ingest/domain/ai-utils';
import { canonicalizeEntityName, entityExtractionExclusionNames, toStoredResourceEntities } from './normalize';

describe('entity normalization', () => {
	it('canonicalizes Unicode width, whitespace, casing, and surrounding quotes', () => {
		assert.equal(canonicalizeEntityName(' “ＯｐｅｎＡＩ” '), 'openai');
		assert.equal(canonicalizeEntityName('Claude   Code'), 'claude code');
	});

	it('filters source aliases, generic names, tickers, invalid types, and duplicate keys', () => {
		const stored = toStoredResourceEntities(
			[
				{ name: 'Teortaxes', name_cn: 'Teortaxes', type: 'person' },
				{ name: '@teortaxes', name_cn: '@teortaxes', type: 'person' },
				{ name: 'Twitter', name_cn: 'Twitter', type: 'organization' },
				{ name: 'AI', name_cn: '人工智慧', type: 'technology' },
				{ name: '$GOOGL', name_cn: 'GOOGL', type: 'organization' },
				{ name: 'Made Up', name_cn: '虛構', type: 'unsupported' },
				{ name: 'Claude Code', name_cn: 'Claude Code', type: 'product' },
				{ name: '“Claude   Code”', name_cn: 'Claude Code', type: 'technology' },
				{ name: 'Yahoo!', name_cn: '  ', type: 'product' },
			],
			'twitter',
			'Teortaxes',
			{
				fetchedAt: '2026-07-27T00:00:00.000Z',
				data: { authorName: 'Teortaxes', authorUserName: 'teortaxes' },
			},
		);

		assert.deepEqual(stored, [
			{ k: 'claude code', n: 'Claude Code', cn: 'Claude Code', t: 'product' },
			{ k: 'yahoo!', n: 'Yahoo!', cn: null, t: 'product' },
		]);
	});

	it('caps stored entities and returns a stable canonical order', () => {
		const stored = toStoredResourceEntities(
			Array.from({ length: 12 }, (_, index) => ({
				name: `Product ${String(11 - index).padStart(2, '0')}`,
				name_cn: `產品 ${11 - index}`,
				type: 'product',
			})),
			'web',
			'Example News',
		);

		assert.equal(stored.length, 10);
		assert.deepEqual(
			stored.map((entity) => entity.k),
			[
				'product 02',
				'product 03',
				'product 04',
				'product 05',
				'product 06',
				'product 07',
				'product 08',
				'product 09',
				'product 10',
				'product 11',
			],
		);
	});

	it('derives deterministic prompt and storage exclusions from source metadata', () => {
		assert.deepEqual(
			entityExtractionExclusionNames('youtube', 'https://www.example.com/feed', {
				fetchedAt: '2026-07-27T00:00:00.000Z',
				data: { channelName: 'Example Channel' },
			}),
			['https://www.example.com/feed', 'example.com', 'example', 'Example Channel', 'YouTube'],
		);
	});
});

describe('classification merge', () => {
	it('keeps an explicit empty entity result so persistence clears stale annotations', () => {
		const resource: ResourceForProcessing = {
			id: 'resource-1',
			source_id: null,
			type: 'web',
			scope: 'corpus',
			original_lang: 'en',
			title: 'A short update',
			summary: null,
			content: 'No important named entities appear here.',
			translations: {},
			url: 'https://example.com/update',
			source: 'Example News',
			published_date: null,
			tags: [],
			keywords: [],
			platform_metadata: {
				fetchedAt: '2026-07-27T00:00:00.000Z',
				data: null,
			},
		};

		const result = mergeResourceClassification(resource, {
			tags: ['Announcement'],
			keywords: ['update'],
			category: 'Other',
			entities: [],
		});

		assert.deepEqual(result, {
			updateData: {
				tags: ['Announcement', 'Other'],
				keywords: ['update'],
				entities: [],
			},
			classificationCategory: 'Other',
		});
	});
});
