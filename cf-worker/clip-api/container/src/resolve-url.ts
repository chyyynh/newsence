import { execFile } from 'child_process';

export interface StreamUrls {
	videoUrl: string;
	audioUrl: string;
}

/**
 * Resolve direct stream URLs from YouTube using yt-dlp --get-url.
 * Only resolves URLs (~2-3s), does NOT download the video.
 */
export function resolveStreamUrls(videoId: string): Promise<StreamUrls> {
	const url = `https://www.youtube.com/watch?v=${videoId}`;

	return new Promise((resolve, reject) => {
		console.log(`[resolve] Resolving stream URLs for ${videoId}...`);

		execFile(
			'yt-dlp',
			['--get-url', '-f', 'bv[height<=480]+ba/b[height<=480]', '--no-playlist', '--no-warnings', url],
			{ timeout: 30_000 },
			(err, stdout, stderr) => {
				if (err) {
					console.error('[resolve] yt-dlp error:', stderr);
					reject(new Error(`URL resolve failed: ${stderr || err.message}`));
					return;
				}

				const urls = stdout.trim().split('\n').filter(Boolean);
				if (urls.length === 0) {
					reject(new Error('No stream URLs resolved'));
					return;
				}

				if (urls.length >= 2) {
					console.log('[resolve] Got separate video + audio URLs');
					resolve({ videoUrl: urls[0], audioUrl: urls[1] });
				} else {
					console.log('[resolve] Got single muxed URL');
					resolve({ videoUrl: urls[0], audioUrl: urls[0] });
				}
			},
		);
	});
}
