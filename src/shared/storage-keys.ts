/**
 * Our own storage/asset addressing conventions: how R2 keys are laid out and how
 * a key maps to the frontend asset route. Distinct from `web.ts`, which handles
 * untrusted *external* URLs (fetch/validate/normalize) — here we only *generate*
 * trusted internal identifiers from our own data.
 */

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

/**
 * Build the R2 storage key for a user-owned upload. All three blob-ingest paths
 * (multipart, external image URL, URL→blob) share this `users/<id>/uploads/<uuid>`
 * layout — keeping the convention here means no path can drift from it.
 */
export function userUploadKey(userId: string, extension: string): string {
	return `users/${userId}/uploads/${crypto.randomUUID()}.${extension}`;
}
