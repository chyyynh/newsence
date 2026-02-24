import { randomUUID } from 'crypto';
import express from 'express';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clipFromUrls } from './ffmpeg.js';
import { resolveStreamUrls } from './resolve-url.js';
import { generateAss } from './subtitle.js';
import { uploadToR2 } from './upload.js';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '8080', 10);

// ── Job state management ────────────────────────────────────

type JobStatus = 'queued' | 'downloading' | 'clipping' | 'uploading' | 'done' | 'error';

interface JobResult {
	clipUrl: string;
	durationSeconds: number;
	fileName: string;
}

interface JobState {
	status: JobStatus;
	videoId: string;
	startTime: number;
	endTime: number;
	createdAt: number;
	progress?: number;
	result?: JobResult;
	error?: string;
}

const jobs = new Map<string, JobState>();

// Cleanup jobs older than 30 minutes every 10 minutes
setInterval(() => {
	const cutoff = Date.now() - 30 * 60_000;
	for (const [id, job] of jobs) {
		if (job.createdAt < cutoff) jobs.delete(id);
	}
}, 10 * 60_000);

// ── Routes ──────────────────────────────────────────────────

app.get('/health', (_req, res) => {
	res.json({ status: 'ok' });
});

interface ClipRequest {
	videoId: string;
	startTime: number;
	endTime: number;
	title?: string;
	subtitles?: Array<{
		startTime: number;
		endTime: number;
		text: string;
		translation?: string;
	}>;
	burnSubtitles?: boolean;
	/** Optional — provided by DO when re-dispatching orphaned jobs */
	jobId?: string;
}

app.post('/clip', (req, res) => {
	const body = req.body as ClipRequest;
	const { videoId, startTime, endTime, title, subtitles, burnSubtitles = true } = body;

	if (!videoId || startTime == null || endTime == null) {
		res.status(400).json({ error: 'videoId, startTime, endTime are required' });
		return;
	}

	if (endTime <= startTime || endTime - startTime < 1) {
		res.status(400).json({ error: 'endTime must be at least 1 second after startTime' });
		return;
	}

	const duration = endTime - startTime;
	if (duration > 600) {
		res.status(400).json({ error: 'Maximum clip duration is 10 minutes' });
		return;
	}

	const jobId = body.jobId || randomUUID();
	const job: JobState = {
		status: 'queued',
		videoId,
		startTime,
		endTime,
		createdAt: Date.now(),
	};
	jobs.set(jobId, job);

	// Run processing in the background — catch to prevent unhandled rejection crash
	processJob(jobId, job, { videoId, startTime, endTime, duration, title, subtitles, burnSubtitles }).catch((err) => {
		console.error(`[clip] Unhandled error in job ${jobId}:`, err);
		job.status = 'error';
		job.error = err instanceof Error ? err.message : 'Internal error';
	});

	res.status(202).json({ jobId });
});

app.get('/clip/:jobId', (req, res) => {
	const { jobId } = req.params;
	const job = jobs.get(jobId);

	if (!job) {
		res.status(404).json({ error: 'Job not found' });
		return;
	}

	res.json(job);

	// Auto-cleanup done/error jobs after 60 seconds
	if (job.status === 'done' || job.status === 'error') {
		setTimeout(() => jobs.delete(jobId), 60_000);
	}
});

// ── Background processing ───────────────────────────────────

interface ProcessParams {
	videoId: string;
	startTime: number;
	endTime: number;
	duration: number;
	title?: string;
	subtitles?: ClipRequest['subtitles'];
	burnSubtitles: boolean;
}

async function processJob(jobId: string, job: JobState, params: ProcessParams): Promise<void> {
	const { videoId, startTime, endTime, duration, title, subtitles, burnSubtitles } = params;
	const workDir = mkdtempSync(join(tmpdir(), 'clip-'));
	console.log(`[clip] Job ${jobId}: ${videoId} ${startTime}-${endTime}s, workDir=${workDir}`);

	try {
		// 1. Resolve stream URLs (fast, ~2-3s — no download)
		job.status = 'downloading';
		const { videoUrl, audioUrl } = await resolveStreamUrls(videoId);

		// 2. Generate ASS subtitles if needed
		job.status = 'clipping';
		let assPath: string | undefined;
		if (subtitles && subtitles.length > 0 && burnSubtitles) {
			assPath = generateAss(subtitles, startTime, workDir);
		}

		// 3. Clip directly from URLs — only downloads the needed segment
		const outputPath = await clipFromUrls({
			videoUrl,
			audioUrl,
			startTime,
			duration,
			assPath,
			workDir,
			onProgress: (percent) => {
				job.progress = percent;
			},
		});

		// 4. Upload to R2
		job.status = 'uploading';
		const clipUrl = await uploadToR2(outputPath, videoId, startTime, endTime);

		const fileName = title ? `${title.replace(/[^\w\u4e00-\u9fff-]/g, '_')}.mp4` : `${videoId}_${startTime}-${endTime}.mp4`;

		job.status = 'done';
		job.result = { clipUrl, durationSeconds: duration, fileName };
		console.log(`[clip] Job ${jobId} done: ${clipUrl}`);
	} catch (err) {
		console.error(`[clip] Job ${jobId} error:`, err);
		job.status = 'error';
		job.error = err instanceof Error ? err.message : 'Internal error';
	} finally {
		try {
			if (existsSync(workDir)) {
				rmSync(workDir, { recursive: true, force: true });
			}
		} catch {
			console.warn(`[clip] Failed to cleanup ${workDir}`);
		}
	}
}

app.listen(PORT, () => {
	console.log(`Clip API listening on port ${PORT}`);
});
