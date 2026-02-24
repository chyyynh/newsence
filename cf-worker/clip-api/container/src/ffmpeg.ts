import { spawn } from 'child_process';
import { join } from 'path';

interface ClipFromUrlsOptions {
	videoUrl: string;
	audioUrl: string;
	startTime: number;
	duration: number;
	assPath?: string;
	workDir: string;
	onProgress?: (percent: number) => void;
}

/**
 * Clip video directly from stream URLs using ffmpeg.
 * Uses input seeking (-ss before -i) so ffmpeg sends HTTP byte-range requests
 * and only downloads the needed segment — NOT the full video.
 */
export function clipFromUrls(options: ClipFromUrlsOptions): Promise<string> {
	const { videoUrl, audioUrl, startTime, duration, assPath, workDir, onProgress } = options;
	const outputPath = join(workDir, 'output.mp4');
	const isSameUrl = videoUrl === audioUrl;

	const args: string[] = [];

	// Input seeking — ffmpeg uses HTTP byte-range to skip ahead
	args.push('-ss', String(startTime));
	args.push('-i', videoUrl);

	if (!isSameUrl) {
		args.push('-ss', String(startTime));
		args.push('-i', audioUrl);
	}

	args.push('-t', String(duration));

	// Map streams
	if (isSameUrl) {
		args.push('-map', '0:v:0', '-map', '0:a:0');
	} else {
		args.push('-map', '0:v:0', '-map', '1:a:0');
	}

	if (assPath) {
		// Subtitle burn — needs re-encoding
		args.push(
			'-vf',
			`ass=${assPath},scale=-2:480`,
			'-c:v',
			'libx264',
			'-preset',
			'ultrafast',
			'-crf',
			'23',
			'-c:a',
			'aac',
			'-b:a',
			'128k',
			'-movflags',
			'+faststart',
		);
	} else {
		// No subtitles — stream copy (very fast)
		args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
	}

	args.push('-y', outputPath);

	return new Promise((resolve, reject) => {
		console.log(`[ffmpeg] Clipping from URL: ss=${startTime}s, t=${duration}s, subs=${!!assPath}`);

		const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stderrBuf = '';
		let settled = false;

		proc.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			stderrBuf += text;

			// Parse progress (only meaningful during re-encoding with subtitles)
			if (onProgress && assPath) {
				const match = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
				if (match) {
					const elapsed = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
					onProgress(Math.min(99, Math.round((elapsed / duration) * 100)));
				}
			}
		});

		proc.on('close', (code) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;

			if (code !== 0) {
				const tail = stderrBuf.slice(-500);
				console.error('[ffmpeg] error:', tail);
				reject(new Error(`FFmpeg failed (code ${code}): ${tail.slice(-200)}`));
				return;
			}
			console.log('[ffmpeg] Done');
			if (onProgress) onProgress(100);
			resolve(outputPath);
		});

		proc.on('error', (err) => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				reject(new Error(`FFmpeg spawn error: ${err.message}`));
			}
		});

		// Timeout
		const timeout = assPath ? 300_000 : 120_000;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				proc.kill('SIGKILL');
				reject(new Error('FFmpeg timeout'));
			}
		}, timeout);
	});
}
