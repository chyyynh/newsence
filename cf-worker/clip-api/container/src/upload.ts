import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { readFileSync, statSync } from 'fs';

function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) {
		console.error(`${name} is required`);
		process.exit(1);
	}
	return val;
}

const R2_ACCOUNT_ID = requireEnv('R2_ACCOUNT_ID');
const R2_ACCESS_KEY_ID = requireEnv('R2_ACCESS_KEY_ID');
const R2_SECRET_ACCESS_KEY = requireEnv('R2_SECRET_ACCESS_KEY');
const R2_BUCKET = process.env.R2_BUCKET || 'newsence';
const R2_PUBLIC_URL = requireEnv('R2_PUBLIC_URL');

const s3 = new S3Client({
	region: 'auto',
	endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
	},
});

/**
 * Upload a clip to Cloudflare R2 and return the public URL.
 */
export async function uploadToR2(filePath: string, videoId: string, startTime: number, endTime: number): Promise<string> {
	const id = randomUUID().slice(0, 8);
	const key = `clips/${videoId}_${startTime}-${endTime}_${id}.mp4`;

	const fileBuffer = readFileSync(filePath);
	const stats = statSync(filePath);

	console.log(`[upload] Uploading ${(stats.size / 1024 / 1024).toFixed(1)}MB to R2: ${key}`);

	await s3.send(
		new PutObjectCommand({
			Bucket: R2_BUCKET,
			Key: key,
			Body: fileBuffer,
			ContentType: 'video/mp4',
		}),
	);

	const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
	console.log(`[upload] Done: ${publicUrl}`);
	return publicUrl;
}
