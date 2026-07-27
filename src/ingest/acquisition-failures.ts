/**
 * Shared vocabulary for "this acquisition will never succeed", used by every
 * platform scraper and by the workflow that decides how hard to retry. It lives
 * beside `acquisition.ts` rather than in one scraper so a platform module never
 * has to import from a sibling it has nothing to do with.
 */

// Statuses where the server has answered about this URL rather than about its own
// health. 429 and every 5xx are deliberately absent: those can differ next time.
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 406, 410, 451]);

export class AcquisitionHttpError extends Error {
	constructor(
		readonly status: number,
		statusText: string,
	) {
		super(`HTTP ${status}: ${statusText}`);
		this.name = 'AcquisitionHttpError';
	}
}

/** The source was fetched; re-reading the same bytes cannot produce a different verdict. */
export class UnreadableContentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnreadableContentError';
	}
}

/** We fetched it, understood it, and do not want it. Not a fault — a policy decision. */
export class IngestPolicySkip extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'IngestPolicySkip';
	}
}

/**
 * Raised outside the acquisition step once the step has reported a permanent
 * verdict, so the workflow's failure handler can tell "this URL will never work"
 * from "this run went wrong" and skip the monitor retries too.
 */
export class PermanentAcquisitionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PermanentAcquisitionError';
	}
}

/** True when a retry would repeat the identical request and receive the identical answer. */
export function isPermanentAcquisitionFailure(error: unknown): boolean {
	if (error instanceof UnreadableContentError || error instanceof IngestPolicySkip) return true;
	return error instanceof AcquisitionHttpError && PERMANENT_HTTP_STATUSES.has(error.status);
}
