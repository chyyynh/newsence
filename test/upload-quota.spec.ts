import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/infra/db';
import { assertBlobUploadQuotaTx, UploadQuotaExceededError } from '../src/infra/upload-quota';

function mockDb(rowsByQuery: Array<Array<Record<string, unknown>>>) {
	const query = vi.fn(async () => ({ rows: rowsByQuery.shift() ?? [] }));
	return { db: { query } as DbClient, query };
}

describe('assertBlobUploadQuotaTx', () => {
	it('rejects free users when the blob file count is exhausted', async () => {
		const { db } = mockDb([[], [{ plan_id: 'free' }], [{ total_bytes: '1024', total_files: '50' }]]);
		const check = assertBlobUploadQuotaTx(db, 'user-1', 100);

		await expect(check).rejects.toThrow(UploadQuotaExceededError);
		await expect(check).rejects.toThrow('Upload file quota exceeded');
	});

	it('rejects free users when incoming bytes exceed blob storage quota', async () => {
		const { db } = mockDb([[], [{ plan_id: 'free' }], [{ total_bytes: `${100 * 1024 * 1024 - 50}`, total_files: '1' }]]);

		await expect(assertBlobUploadQuotaTx(db, 'user-1', 100)).rejects.toThrow(UploadQuotaExceededError);
	});

	it('skips usage lookup for unlimited upload plans', async () => {
		const { db, query } = mockDb([[], [{ plan_id: 'pro' }]]);

		await expect(assertBlobUploadQuotaTx(db, 'user-1', 100)).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledTimes(2);
	});
});
