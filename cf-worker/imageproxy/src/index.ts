/**
 * Image Proxy Worker using Cloudflare Image Resizing
 * Proxies images with optimization, caching, and resizing capabilities
 *
 * Usage: /cdn-cgi/image/width=800,quality=85,format=auto/https://example.com/image.jpg
 */

interface Env {
	// Add environment variables here if needed
}

export default {
	async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health check endpoint
		if (url.pathname === '/health') {
			return new Response('OK', { status: 200 });
		}

		// Parse URL: /cdn-cgi/image/{options}/{imageUrl}
		const match = url.pathname.match(/^\/cdn-cgi\/image\/([^/]+)\/(.+)$/);

		if (!match) {
			return new Response('Invalid URL format. Expected: /cdn-cgi/image/{options}/{imageUrl}', {
				status: 400,
			});
		}

		const [, optionsStr, imageUrl] = match;

		// Validate image URL
		if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
			return new Response('Invalid image URL. Must start with http:// or https://', {
				status: 400,
			});
		}

		// Parse options (e.g., "width=800,quality=85,format=auto")
		const options = parseOptions(optionsStr);

		try {
			// Fetch the original image
			const imageResponse = await fetch(imageUrl, {
				cf: {
					image: {
						width: options.width,
						quality: options.quality,
						format: (options.format === 'auto' ? 'auto' : options.format) as
							| 'avif'
							| 'webp'
							| 'json'
							| 'jpeg'
							| 'png'
							| 'baseline-jpeg'
							| 'png-force'
							| 'svg'
							| undefined,
						fit: options.fit || 'scale-down',
					},
					cacheEverything: true,
					cacheTtl: 60 * 60 * 24 * 30, // Cache for 30 days
				},
			});

			if (!imageResponse.ok) {
				return new Response(`Failed to fetch image: ${imageResponse.statusText}`, {
					status: imageResponse.status,
				});
			}

			// Create response with proper headers
			const headers = new Headers(imageResponse.headers);
			headers.set('Cache-Control', 'public, max-age=31536000, immutable');
			headers.set('Access-Control-Allow-Origin', '*');

			return new Response(imageResponse.body, {
				status: imageResponse.status,
				headers,
			});
		} catch (error) {
			console.error('Image proxy error:', error);
			return new Response(`Error processing image: ${error}`, {
				status: 500,
			});
		}
	},
} satisfies ExportedHandler<Env>;

interface ImageOptions {
	width?: number;
	height?: number;
	quality?: number;
	format?: string;
	fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
}

function parseOptions(optionsStr: string): ImageOptions {
	const options: ImageOptions = {
		quality: 85,
		format: 'auto',
		fit: 'scale-down',
	};

	const pairs = optionsStr.split(',');
	for (const pair of pairs) {
		const [key, value] = pair.split('=');
		switch (key) {
			case 'width':
			case 'w':
				options.width = parseInt(value, 10);
				break;
			case 'height':
			case 'h':
				options.height = parseInt(value, 10);
				break;
			case 'quality':
			case 'q':
				options.quality = parseInt(value, 10);
				break;
			case 'format':
			case 'f':
				options.format = value;
				break;
			case 'fit':
				options.fit = value as ImageOptions['fit'];
				break;
		}
	}

	return options;
}
