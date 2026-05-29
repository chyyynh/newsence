/**
 * Build the frontend's asset-route URL for an R2 storage key. The frontend's
 * `/api/media/asset/[...key]` route signs and forwards to this worker's
 * `/media/asset/`, so consumers of `assetUrl` always go through Next.js auth.
 *
 * Keeping the prefix in the worker means every endpoint that returns a
 * `storageKey` can also emit a ready-to-render `assetUrl` — callers never
 * have to know the route shape.
 */
export function storageKeyToAssetUrl(key: string): string {
	return `/api/media/asset/${key}`;
}
