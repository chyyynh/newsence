import { introspectWorkflowInstance } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

declare module 'cloudflare:workers' {
	interface ProvidedEnv extends CoreEnv {}
}

const FIXED_DATE = '2026-07-09T00:00:00.000Z';
const USER_FILE_ID = 'user-file-youtube-regression';
const WORKFLOW_ID = 'workflow-user-file-youtube-regression';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const savedUrlShell = {
	id: USER_FILE_ID,
	title: 'youtube.com',
	title_cn: null,
	summary: '',
	summary_cn: null,
	content: null,
	url: YOUTUBE_URL,
	source: 'youtube.com',
	published_date: FIXED_DATE,
	tags: [],
	keywords: [],
	source_type: 'web',
	platform_metadata: { type: 'default', fetchedAt: FIXED_DATE, data: null },
	entities: null,
	has_content: false,
	storage_key: null,
	file_type: 'web',
};

const acquiredYouTubeContent = {
	title: 'How robots learn from messy data',
	markdown: 'Transcript line one.\nTranscript line two.',
	metadata: {
		author: 'Newsence Lab',
		publishedDate: FIXED_DATE,
		siteName: 'YouTube',
		description: 'A video about robot learning.',
	},
	platformMetadata: {
		type: 'youtube',
		fetchedAt: FIXED_DATE,
		data: {
			videoId: 'dQw4w9WgXcQ',
			channelName: 'Newsence Lab',
			channelId: 'channel-1',
			duration: 'PT8M30S',
			thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
			publishedAt: FIXED_DATE,
			description: 'A video about robot learning.',
			tags: ['robotics', 'ai'],
		},
	},
	youtubeTranscript: {
		videoId: 'dQw4w9WgXcQ',
		language: 'en',
		segments: [{ startTime: 0, endTime: 5, text: 'Transcript line one.' }],
		chapters: [],
		chaptersFromDescription: false,
	},
};

const processorResult = {
	updateData: {
		title_cn: '機器人如何從雜亂資料學習',
		summary: 'A video about robot learning.',
		summary_cn: '這支影片介紹機器人如何從雜亂資料學習。',
		tags: ['AI'],
		keywords: ['robotics'],
		entities: [],
	},
	classificationCategory: 'AI',
	enrichments: {},
};

const youtubeHighlights = {
	videoId: 'dQw4w9WgXcQ',
	value: {
		version: '1.0',
		model: 'test-model',
		generatedAt: FIXED_DATE,
		highlights: [{ title: '開場', summary: '說明影片主題。', startTime: 0, endTime: 5 }],
	},
};

describe('NewsenceMonitorWorkflow', () => {
	it('branches on acquired saved-URL platform metadata before processing', async () => {
		const instance = await introspectWorkflowInstance(env.MONITOR_WORKFLOW, WORKFLOW_ID);
		const acquiredArtifact = JSON.stringify(acquiredYouTubeContent);

		try {
			await instance.modify(async (modifier) => {
				await modifier.disableSleeps();
				await modifier.disableRetryDelays();
				await modifier.mockStepResult({ name: 'fetch-article-shell' }, savedUrlShell);
				await modifier.mockStepResult({ name: 'acquire-content' }, acquiredArtifact);
				await modifier.mockStepResult({ name: 'ai-analysis' }, processorResult);
				await modifier.mockStepResult({ name: 'generate-embedding' }, [0.1, 0.2, 0.3]);
				await modifier.mockStepResult({ name: 'prepare-youtube-highlights' }, youtubeHighlights);
				await modifier.mockStepResult({ name: 'update-db' }, USER_FILE_ID);
			});

			await env.MONITOR_WORKFLOW.create({
				id: WORKFLOW_ID,
				params: { target: { kind: 'userFile', rowId: USER_FILE_ID } },
			});

			await expect(instance.waitForStepResult({ name: 'acquire-content' })).resolves.toBe(acquiredArtifact);
			await expect(instance.waitForStepResult({ name: 'prepare-youtube-highlights' })).resolves.toEqual(youtubeHighlights);
			await expect(instance.waitForStatus('complete')).resolves.not.toThrow();
			await expect(instance.getOutput()).resolves.toEqual({ success: true, article_id: USER_FILE_ID });
		} finally {
			await instance.dispose();
		}
	});
});
