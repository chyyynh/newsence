import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { DbClient } from '@shared/db';
import { withDbClient, withDbTransaction } from '@shared/db';
import type { Env } from '@shared/types';
import { storageKeyToAssetUrl, userPodcastAudioKey } from '@shared/upload';
import type { JSONContent } from '@tiptap/core';
import { AUDIO_MODEL_PRICING } from '@worker-contracts/chat-models';
import { contentToMarkdown } from '@worker-contracts/editor-markdown';
import {
	GEMINI_TTS_MODEL,
	type PodcastContextSource,
	type PodcastLanguage,
	type PodcastScript,
	type PodcastSpeaker,
	type PodcastStatus,
	type PodcastSummary,
	type PodcastWorkflowParams,
	type WorkspacePodcastContextResult,
} from '@worker-contracts/podcast-contracts';

const MAX_CONTEXT_SOURCES = 24;
const MAX_CONTEXT_DOCUMENTS = 10;
const MAX_SOURCE_CHARS = 6000;
const MAX_CONTEXT_CHARS = 80_000;
const GEMINI_TTS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_SAMPLE_RATE = 24_000;
const GEMINI_SAMPLE_WIDTH_BYTES = 2;
const CREDITS_PER_USD = 1000;

type PodcastAudioExtension = 'wav';
type PodcastAudioFormat = {
	contentType: string;
	extension: PodcastAudioExtension;
	durationSec: (bytes: Uint8Array) => number;
};
type PodcastForSynthesis = {
	id: string;
	lang: PodcastLanguage;
	script: PodcastScript;
	title: string;
	userId: string;
};
type PodcastTtsProvider = {
	format: PodcastAudioFormat;
	id: 'gemini';
	modelId: string;
	synthesize: (env: Env, podcast: PodcastForSynthesis) => Promise<Uint8Array>;
};

type PodcastRow = {
	id: string;
	workspace_id: string;
	title: string;
	status: string;
	audio_url: string | null;
	duration_sec: number | null;
	lang: string;
	error: string | null;
	workflow_run_id?: string | null;
	created_at: Date | string;
	updated_at: Date | string;
	script?: unknown;
};

type WorkspaceRow = { id: string; title: string; description: string | null };
type DocumentRow = { id: string; title: string; description: string | null; content: JSONContent | null; updated_at: Date | string };
type CitationRow = { to_type: string; to_id: string; from_id?: string; created_at?: Date | string };
type ArticleRow = {
	id: string;
	title: string | null;
	title_cn: string | null;
	url: string | null;
	source: string | null;
	summary: string | null;
	summary_cn: string | null;
	content: string | null;
	content_cn: string | null;
};
type UserFileRow = {
	id: string;
	file_name: string;
	title: string | null;
	title_cn: string | null;
	source_url: string | null;
	site_name: string | null;
	summary: string | null;
	summary_cn: string | null;
	extracted_text: string | null;
	content_cn: string | null;
};
type CollectionRow = { id: string; name: string; description: string | null; article_count: number };

class PodcastNotFoundError extends Error {
	constructor() {
		super('Podcast not found');
		this.name = 'PodcastNotFoundError';
	}
}

class PodcastNotReadyError extends Error {
	constructor() {
		super('Podcast is not ready for synthesis');
		this.name = 'PodcastNotReadyError';
	}
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function dateIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parsePodcastStatus(value: string): PodcastStatus {
	if (value === 'pending' || value === 'scripting' || value === 'synthesizing' || value === 'complete' || value === 'failed') return value;
	return 'failed';
}

function parsePodcastLanguage(value: string): PodcastLanguage {
	return value === 'en' ? 'en' : 'zh-TW';
}

function parsePodcastSpeaker(value: unknown): PodcastSpeaker {
	if (value === 'host_a' || value === 'host_b') return value;
	throw new Error('Invalid podcast speaker');
}

function parsePodcastScript(value: unknown): PodcastScript {
	if (!value || typeof value !== 'object') throw new Error('Invalid podcast script');
	const record = value as Record<string, unknown>;
	const lines = Array.isArray(record.lines) ? record.lines : null;
	if (!lines || lines.length < 6 || lines.length > 80) throw new Error('Invalid podcast script lines');
	return {
		scratchpad: typeof record.scratchpad === 'string' ? record.scratchpad.trim() : '',
		lines: lines.map((line) => {
			if (!line || typeof line !== 'object') throw new Error('Invalid podcast script line');
			const lineRecord = line as Record<string, unknown>;
			const text = typeof lineRecord.text === 'string' ? lineRecord.text.trim() : '';
			if (!text) throw new Error('Podcast script line cannot be empty');
			return {
				speaker: parsePodcastSpeaker(lineRecord.speaker),
				text,
			};
		}),
	};
}

function podcastSummary(row: PodcastRow): PodcastSummary {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		title: row.title,
		status: parsePodcastStatus(row.status),
		lang: parsePodcastLanguage(row.lang),
		audioUrl: row.audio_url,
		durationSec: row.duration_sec,
		error: row.error,
		createdAt: dateIso(row.created_at),
		updatedAt: dateIso(row.updated_at),
	};
}

function compact(value: string | null | undefined): string {
	return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function truncate(value: string, max = MAX_SOURCE_CHARS): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max).trimEnd()}\n\n[truncated]`;
}

function sourceBlock(source: PodcastContextSource): string {
	const lines = [
		`### ${source.title}`,
		`Type: ${source.type}`,
		source.source ? `Source: ${source.source}` : '',
		source.url ? `URL: ${source.url}` : '',
		'',
		source.content,
	];
	return lines.filter(Boolean).join('\n');
}

function buildContextMarkdown(workspace: WorkspaceRow, sources: PodcastContextSource[]): string {
	const header = [`# Workspace: ${workspace.title}`, workspace.description ? `Description: ${workspace.description}` : '']
		.filter(Boolean)
		.join('\n');
	const body = sources.map(sourceBlock).join('\n\n');
	return truncate([header, body].filter(Boolean).join('\n\n'), MAX_CONTEXT_CHARS);
}

function articleSource(row: ArticleRow): PodcastContextSource {
	const title = compact(row.title_cn) || compact(row.title) || 'Untitled article';
	const summary = [compact(row.summary_cn), compact(row.summary)].filter(Boolean).join('\n');
	const content = [summary, compact(row.content_cn), compact(row.content)].filter(Boolean).join('\n\n');
	return {
		id: row.id,
		type: 'article',
		title,
		url: row.url,
		source: row.source,
		content: truncate(content || title),
	};
}

function userFileSource(row: UserFileRow): PodcastContextSource {
	const title = compact(row.title_cn) || compact(row.title) || compact(row.file_name) || 'Untitled file';
	const summary = [compact(row.summary_cn), compact(row.summary)].filter(Boolean).join('\n');
	const content = [summary, compact(row.content_cn), compact(row.extracted_text)].filter(Boolean).join('\n\n');
	return {
		id: row.id,
		type: 'user_file',
		title,
		url: row.source_url,
		source: row.site_name,
		content: truncate(content || title),
	};
}

function documentSource(row: DocumentRow): PodcastContextSource {
	const markdown = contentToMarkdown(row.content ?? { type: 'doc', content: [{ type: 'paragraph' }] });
	return {
		id: row.id,
		type: 'document',
		title: compact(row.title) || 'Untitled document',
		content: truncate([compact(row.description), markdown].filter(Boolean).join('\n\n') || row.title),
	};
}

function collectionSource(row: CollectionRow): PodcastContextSource {
	return {
		id: row.id,
		type: 'collection',
		title: row.name,
		content: truncate([row.description, `${row.article_count} articles`].filter(Boolean).join('\n')),
	};
}

async function assertWorkspace(db: DbClient, userId: string, workspaceId: string): Promise<WorkspaceRow> {
	if (!isUuid(workspaceId)) throw new Error('Workspace not found');
	const row = (
		await db.query<WorkspaceRow>('SELECT id, title, description FROM workspaces WHERE id = $1 AND user_id = $2 LIMIT 1', [
			workspaceId,
			userId,
		])
	).rows[0];
	if (!row) throw new Error('Workspace not found');
	return row;
}

export async function createPodcast(
	env: Env,
	input: { userId: string; workspaceId: string; lang: PodcastLanguage; title?: string },
): Promise<PodcastSummary> {
	return withDbClient(env, async (db) => {
		const workspace = await assertWorkspace(db, input.userId, input.workspaceId);
		const title = input.title?.trim().slice(0, 200) || `${workspace.title} Audio Overview`;
		const row = (
			await db.query<PodcastRow>(
				`INSERT INTO user_podcasts (user_id, workspace_id, title, status, lang)
				 VALUES ($1, $2, $3, 'scripting', $4)
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at`,
				[input.userId, input.workspaceId, title, input.lang],
			)
		).rows[0];
		return podcastSummary(row);
	});
}

function addTarget(targets: CitationRow[], seen: Set<string>, row: CitationRow) {
	if (!isUuid(row.to_id)) return;
	if (row.to_type !== 'article' && row.to_type !== 'user_file' && row.to_type !== 'document' && row.to_type !== 'collection') return;
	const key = `${row.to_type}:${row.to_id}`;
	if (seen.has(key)) return;
	seen.add(key);
	targets.push(row);
}

async function collectionMemberTargets(db: DbClient, userId: string, collectionIds: string[]): Promise<CitationRow[]> {
	if (collectionIds.length === 0) return [];
	return (
		await db.query<CitationRow>(
			`SELECT from_id, to_type, to_id, created_at
			 FROM citations
			 WHERE user_id = $1 AND from_type = 'collection' AND from_id = ANY($2::text[])
			 ORDER BY created_at DESC
			 LIMIT 120`,
			[userId, collectionIds],
		)
	).rows;
}

function collectPodcastTargets(directRows: CitationRow[], memberRows: CitationRow[]): CitationRow[] {
	const targets: CitationRow[] = [];
	const seen = new Set<string>();
	for (const row of directRows) addTarget(targets, seen, row);
	for (const row of memberRows) addTarget(targets, seen, row);
	return targets;
}

function targetIds(targets: CitationRow[], type: CitationRow['to_type']): string[] {
	return targets.filter((row) => row.to_type === type).map((row) => row.to_id);
}

async function loadTargetRows(
	db: DbClient,
	userId: string,
	targets: CitationRow[],
): Promise<{
	articles: ArticleRow[];
	collections: CollectionRow[];
	documents: DocumentRow[];
	files: UserFileRow[];
}> {
	const articleIds = targetIds(targets, 'article');
	const userFileIds = targetIds(targets, 'user_file');
	const documentIds = targetIds(targets, 'document');
	const collectionIds = targetIds(targets, 'collection');

	const [articles, files, documents, collections] = await Promise.all([
		articleIds.length
			? db.query<ArticleRow>(
					`SELECT id, title, title_cn, url, source, summary, summary_cn, content, content_cn
					 FROM articles WHERE id = ANY($1::uuid[])`,
					[articleIds],
				)
			: Promise.resolve({ rows: [] as ArticleRow[] }),
		userFileIds.length
			? db.query<UserFileRow>(
					`SELECT id, file_name, title, title_cn, source_url, site_name, summary, summary_cn, extracted_text, content_cn
					 FROM user_files WHERE id = ANY($1::uuid[]) AND user_id = $2`,
					[userFileIds, userId],
				)
			: Promise.resolve({ rows: [] as UserFileRow[] }),
		documentIds.length
			? db.query<DocumentRow>(
					`SELECT id, title, description, content, updated_at
					 FROM user_documents WHERE id = ANY($1::uuid[]) AND user_id = $2`,
					[documentIds, userId],
				)
			: Promise.resolve({ rows: [] as DocumentRow[] }),
		collectionIds.length
			? db.query<CollectionRow>(
					`SELECT id, name, description, article_count
					 FROM collections WHERE id = ANY($1::uuid[]) AND user_id = $2`,
					[collectionIds, userId],
				)
			: Promise.resolve({ rows: [] as CollectionRow[] }),
	]);

	return {
		articles: articles.rows,
		collections: collections.rows,
		documents: documents.rows,
		files: files.rows,
	};
}

function sourceMapFromRows(
	documents: DocumentRow[],
	targetRows: Awaited<ReturnType<typeof loadTargetRows>>,
): Map<string, PodcastContextSource> {
	const sourceByKey = new Map<string, PodcastContextSource>();
	for (const row of documents) sourceByKey.set(`document:${row.id}`, documentSource(row));
	for (const row of targetRows.documents) sourceByKey.set(`document:${row.id}`, documentSource(row));
	for (const row of targetRows.articles) sourceByKey.set(`article:${row.id}`, articleSource(row));
	for (const row of targetRows.files) sourceByKey.set(`user_file:${row.id}`, userFileSource(row));
	for (const row of targetRows.collections) sourceByKey.set(`collection:${row.id}`, collectionSource(row));
	return sourceByKey;
}

function orderedContextSources(
	documents: DocumentRow[],
	targets: CitationRow[],
	sourceByKey: Map<string, PodcastContextSource>,
): PodcastContextSource[] {
	const orderedKeys = [...documents.map((row) => `document:${row.id}`), ...targets.map((row) => `${row.to_type}:${row.to_id}`)];
	const sources: PodcastContextSource[] = [];
	const emitted = new Set<string>();
	for (const key of orderedKeys) {
		if (emitted.has(key)) continue;
		const source = sourceByKey.get(key);
		if (!source || !source.content.trim()) continue;
		emitted.add(key);
		sources.push(source);
		if (sources.length >= MAX_CONTEXT_SOURCES) break;
	}
	return sources;
}

export async function workspacePodcastContext(
	env: Env,
	input: { userId: string; workspaceId: string },
): Promise<WorkspacePodcastContextResult> {
	return withDbClient(env, async (db) => {
		const workspace = await assertWorkspace(db, input.userId, input.workspaceId);
		const [documents, directRows] = await Promise.all([
			db.query<DocumentRow>(
				`SELECT id, title, description, content, updated_at
				 FROM user_documents
				 WHERE workspace_id = $1 AND user_id = $2
				 ORDER BY updated_at DESC
				 LIMIT $3`,
				[input.workspaceId, input.userId, MAX_CONTEXT_DOCUMENTS],
			),
			db.query<CitationRow>(
				`SELECT to_type, to_id, created_at
				 FROM citations
				 WHERE user_id = $1 AND from_type = 'workspace' AND from_id = $2
				 ORDER BY created_at DESC
				 LIMIT 80`,
				[input.userId, input.workspaceId],
			),
		]);

		const collectionIds = directRows.rows.filter((row) => row.to_type === 'collection' && isUuid(row.to_id)).map((row) => row.to_id);
		const memberRows = await collectionMemberTargets(db, input.userId, collectionIds);
		const targets = collectPodcastTargets(directRows.rows, memberRows);
		const targetRows = await loadTargetRows(db, input.userId, targets);
		const sourceByKey = sourceMapFromRows(documents.rows, targetRows);
		const sources = orderedContextSources(documents.rows, targets, sourceByKey);

		return {
			workspaceId: workspace.id,
			title: workspace.title,
			description: workspace.description,
			sources,
			markdown: buildContextMarkdown(workspace, sources),
		};
	});
}

export async function updatePodcastScript(
	env: Env,
	input: { userId: string; podcastId: string; title: string; script: PodcastScript },
): Promise<PodcastSummary> {
	const parsed = parsePodcastScript(input.script);
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<PodcastRow>(
				`UPDATE user_podcasts
				 SET title = $3, script = $4::jsonb, status = 'synthesizing', error = NULL, workflow_run_id = NULL, updated_at = NOW()
				 WHERE id = $1 AND user_id = $2
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at`,
				[input.podcastId, input.userId, input.title.slice(0, 200), JSON.stringify(parsed)],
			)
		).rows[0];
		if (!row) throw new PodcastNotFoundError();
		return podcastSummary(row);
	});
}

export async function failPodcast(
	env: Env,
	input: { userId: string; podcastId: string; error: string; workflowRunId?: string },
): Promise<PodcastSummary> {
	return withDbClient(env, async (db) => {
		const workflowGuard = input.workflowRunId ? 'AND workflow_run_id = $4' : '';
		const values = input.workflowRunId
			? [input.podcastId, input.userId, input.error.slice(0, 1000), input.workflowRunId]
			: [input.podcastId, input.userId, input.error.slice(0, 1000)];
		const row = (
			await db.query<PodcastRow>(
				`UPDATE user_podcasts
				 SET status = 'failed', error = $3, updated_at = NOW()
				 WHERE id = $1 AND user_id = $2 AND status <> 'complete' ${workflowGuard}
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at`,
				values,
			)
		).rows[0];
		if (!row) throw new PodcastNotFoundError();
		return podcastSummary(row);
	});
}

export async function preparePodcastRetry(
	env: Env,
	input: { userId: string; podcastId: string; workspaceId: string },
): Promise<{ needsScript: boolean; podcast: PodcastSummary }> {
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<PodcastRow>(
				`UPDATE user_podcasts
				 SET status = CASE WHEN script IS NULL THEN 'scripting' ELSE 'synthesizing' END,
				     error = NULL,
				     audio_url = NULL,
				     duration_sec = NULL,
				     workflow_run_id = NULL,
				     updated_at = NOW()
				 WHERE id = $1
				   AND user_id = $2
				   AND workspace_id = $3
				   AND status = 'failed'
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at, script`,
				[input.podcastId, input.userId, input.workspaceId],
			)
		).rows[0];
		if (!row) throw new PodcastNotReadyError();
		return { needsScript: row.script == null, podcast: podcastSummary(row) };
	});
}

export async function startPodcastSynthesis(
	env: Env,
	input: { userId: string; podcastId: string },
): Promise<{ instanceId: string; podcastId: string; workflowRunId: string }> {
	const workflowRunId = await claimPodcastWorkflowRun(env, input);
	const instanceId = `podcast-${input.podcastId}-${workflowRunId}`;
	await env.PODCAST_WORKFLOW.create({
		id: instanceId,
		params: { podcastId: input.podcastId, userId: input.userId, workflowRunId } satisfies PodcastWorkflowParams,
	});
	return { instanceId, podcastId: input.podcastId, workflowRunId };
}

async function claimPodcastWorkflowRun(env: Env, params: { podcastId: string; userId: string }): Promise<string> {
	const workflowRunId = crypto.randomUUID();
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<{ workflow_run_id: string }>(
				`UPDATE user_podcasts
				 SET workflow_run_id = $3, updated_at = NOW()
				 WHERE id = $1
				   AND user_id = $2
				   AND status = 'synthesizing'
				   AND script IS NOT NULL
				   AND workflow_run_id IS NULL
				 RETURNING workflow_run_id`,
				[params.podcastId, params.userId, workflowRunId],
			)
		).rows[0];
		if (!row) throw new PodcastNotReadyError();
		return row.workflow_run_id;
	});
}

async function loadPodcastForWorkflow(env: Env, params: PodcastWorkflowParams): Promise<PodcastForSynthesis> {
	return withDbClient(env, async (db) => {
		const row = (
			await db.query<PodcastRow>(
				`SELECT id, title, lang, script
				 FROM user_podcasts
				 WHERE id = $1
				   AND user_id = $2
				   AND workflow_run_id = $3
				   AND status = 'synthesizing'
				   AND script IS NOT NULL
				 LIMIT 1`,
				[params.podcastId, params.userId, params.workflowRunId],
			)
		).rows[0];
		if (!row) throw new PodcastNotReadyError();
		return {
			id: row.id,
			lang: parsePodcastLanguage(row.lang),
			script: parsePodcastScript(row.script),
			title: row.title,
			userId: params.userId,
		};
	});
}

function scriptToTtsPrompt(script: PodcastScript, lang: PodcastLanguage): string {
	const languageLabel = lang === 'zh-TW' ? 'Traditional Chinese (Taiwan)' : 'English';
	const transcript = script.lines.map((line) => `${line.speaker === 'host_a' ? 'Host A' : 'Host B'}: ${line.text}`).join('\n');
	return [
		`TTS the following two-host podcast conversation in ${languageLabel}.`,
		'Host A is calm, analytical, and concise. Host B is curious, conversational, and asks useful follow-up questions.',
		'Keep a natural podcast pace. Preserve the transcript text and speaker labels.',
		'',
		transcript,
	].join('\n');
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function writeAscii(view: DataView, offset: number, value: string) {
	for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function pcmToWav(pcm: Uint8Array, sampleRate = GEMINI_SAMPLE_RATE): Uint8Array {
	const headerSize = 44;
	const wav = new Uint8Array(headerSize + pcm.byteLength);
	const view = new DataView(wav.buffer);
	const byteRate = sampleRate * GEMINI_SAMPLE_WIDTH_BYTES;
	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, 36 + pcm.byteLength, true);
	writeAscii(view, 8, 'WAVE');
	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, GEMINI_SAMPLE_WIDTH_BYTES, true);
	view.setUint16(34, GEMINI_SAMPLE_WIDTH_BYTES * 8, true);
	writeAscii(view, 36, 'data');
	view.setUint32(40, pcm.byteLength, true);
	wav.set(pcm, headerSize);
	return wav;
}

function wavDurationSec(bytes: Uint8Array): number {
	const pcmBytes = Math.max(0, bytes.byteLength - 44);
	return Math.max(1, Math.round(pcmBytes / (GEMINI_SAMPLE_RATE * GEMINI_SAMPLE_WIDTH_BYTES)));
}

const GEMINI_WAV_FORMAT: PodcastAudioFormat = {
	contentType: 'audio/wav',
	extension: 'wav',
	durationSec: wavDurationSec,
};

function outputAudioData(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const record = payload as Record<string, unknown>;
	const audio = record.output_audio ?? record.outputAudio;
	if (!audio || typeof audio !== 'object') return null;
	const data = (audio as Record<string, unknown>).data;
	return typeof data === 'string' && data ? data : null;
}

async function synthesizeWithGemini(env: Env, podcast: PodcastForSynthesis): Promise<Uint8Array> {
	if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
	const response = await fetch(GEMINI_TTS_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': env.GEMINI_API_KEY,
		},
		body: JSON.stringify({
			model: GEMINI_TTS_MODEL,
			input: scriptToTtsPrompt(podcast.script, podcast.lang),
			response_format: { type: 'audio' },
			generation_config: {
				speech_config: [
					{ speaker: 'Host A', voice: 'Kore' },
					{ speaker: 'Host B', voice: 'Puck' },
				],
			},
		}),
	});
	const payload = (await response.json().catch(() => null)) as unknown;
	if (!response.ok) {
		throw new Error(`Gemini TTS failed (${response.status})`);
	}
	const data = outputAudioData(payload);
	if (!data) throw new Error('Gemini TTS returned no audio data');
	return pcmToWav(base64ToBytes(data));
}

const GEMINI_TTS_PROVIDER: PodcastTtsProvider = {
	id: 'gemini',
	format: GEMINI_WAV_FORMAT,
	modelId: GEMINI_TTS_MODEL,
	synthesize: synthesizeWithGemini,
};

function resolvePodcastTtsProvider(_env: Env): PodcastTtsProvider {
	return GEMINI_TTS_PROVIDER;
}

function audioUsageForModel(modelId: string): { costUsd: number; credits: number } {
	const pricing = AUDIO_MODEL_PRICING[modelId];
	if (!pricing) throw new Error(`Unknown audio model "${modelId}"`);
	const costUsd = pricing.perEpisode;
	return { costUsd, credits: Math.ceil(costUsd * CREDITS_PER_USD) };
}

async function settlePodcastAudioUsage(db: DbClient, input: { modelId: string; podcastId: string; providerId: string; userId: string }) {
	const existing = await db.query<{ id: string }>(
		`SELECT id
		 FROM user_ai_usage
		 WHERE user_id = $1
		   AND service_type = 'audio_overview'
		   AND request_metadata->>'podcastId' = $2
		 LIMIT 1`,
		[input.userId, input.podcastId],
	);
	if (existing.rows[0]) return;

	const usage = audioUsageForModel(input.modelId);
	await db.query(
		`INSERT INTO user_ai_usage
		 (user_id, service_type, model_name, input_tokens, output_tokens, total_tokens, credits_used, estimated_cost, request_metadata)
		 VALUES ($1, 'audio_overview', $2, NULL, NULL, 1, $3, $4, $5::jsonb)`,
		[
			input.userId,
			input.modelId,
			usage.credits,
			usage.costUsd,
			JSON.stringify({
				endpoint: 'workflow/podcast',
				phase: 'tts',
				podcastId: input.podcastId,
				provider: input.providerId,
			}),
		],
	);
	const result = await db.query(
		`UPDATE user_settings
		 SET credit_balance = GREATEST(0, credit_balance - $2),
		     credits_used = credits_used + LEAST($2, credit_balance),
		     updated_at = NOW()
		 WHERE user_id = $1`,
		[input.userId, usage.credits],
	);
	if (!result.rowCount) throw new Error(`No user_settings row for user ${input.userId} — cannot settle podcast usage`);
}

async function uploadPodcastAudio(
	env: Env,
	params: PodcastWorkflowParams,
	audioStream: ReadableStream<Uint8Array>,
	format: PodcastAudioFormat,
): Promise<{ audioUrl: string; durationSec: number; storageKey: string }> {
	const bytes = new Uint8Array(await new Response(audioStream).arrayBuffer());
	const storageKey = userPodcastAudioKey(params.userId, params.podcastId, format.extension);
	await env.R2.put(storageKey, bytes, {
		httpMetadata: {
			contentType: format.contentType,
			cacheControl: 'private, max-age=31536000, immutable',
		},
	});
	return {
		audioUrl: storageKeyToAssetUrl(storageKey),
		durationSec: format.durationSec(bytes),
		storageKey,
	};
}

async function completePodcast(
	env: Env,
	params: PodcastWorkflowParams,
	result: { audioUrl: string; durationSec: number },
	provider: PodcastTtsProvider,
): Promise<PodcastSummary> {
	return withDbTransaction(env, 'complete podcast', async (db) => {
		const row = (
			await db.query<PodcastRow>(
				`UPDATE user_podcasts
				 SET status = 'complete', audio_url = $3, duration_sec = $4, error = NULL, updated_at = NOW()
				 WHERE id = $1 AND user_id = $2 AND workflow_run_id = $5 AND status = 'synthesizing'
				 RETURNING id, workspace_id, title, status, audio_url, duration_sec, lang, error, created_at, updated_at`,
				[params.podcastId, params.userId, result.audioUrl, result.durationSec, params.workflowRunId],
			)
		).rows[0];
		if (!row) throw new PodcastNotReadyError();
		await settlePodcastAudioUsage(db, {
			userId: params.userId,
			podcastId: params.podcastId,
			modelId: provider.modelId,
			providerId: provider.id,
		});
		return podcastSummary(row);
	});
}

export class PodcastWorkflow extends WorkflowEntrypoint<Env, PodcastWorkflowParams> {
	async run(
		event: WorkflowEvent<PodcastWorkflowParams>,
		step: WorkflowStep,
	): Promise<{ audioUrl: string; durationSec: number; podcastId: string; storageKey: string }> {
		const params = event.payload;
		const provider = resolvePodcastTtsProvider(this.env);
		try {
			const podcast = await step.do(
				'load-podcast-script',
				{ retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => loadPodcastForWorkflow(this.env, params),
			);
			const audioStream = await step.do(
				`synthesize-${provider.id}-audio`,
				{ retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
				async () => {
					const audio = await provider.synthesize(this.env, podcast);
					return new Response(audio).body as ReadableStream<Uint8Array>;
				},
			);
			const uploaded = await step.do(
				'upload-podcast-audio',
				{ retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
				() => uploadPodcastAudio(this.env, params, audioStream as ReadableStream<Uint8Array>, provider.format),
			);
			await step.do(
				'mark-podcast-complete',
				{ retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
				() => completePodcast(this.env, params, uploaded, provider),
			);
			return { ...uploaded, podcastId: params.podcastId };
		} catch (error) {
			await failPodcast(this.env, {
				userId: params.userId,
				podcastId: params.podcastId,
				workflowRunId: params.workflowRunId,
				error: error instanceof Error ? error.message : String(error),
			}).catch((failure) => console.error({ tag: 'PODCAST_WORKFLOW', msg: 'Failed to mark podcast failed', error: String(failure) }));
			throw error;
		}
	}
}
