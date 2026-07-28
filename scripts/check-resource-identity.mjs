import assert from 'node:assert/strict';
import {
	isIncomingResourceSnapshotSuperseded,
	isResourceTranslationIdentityEligible,
	legacyResourceIdentity,
	legacyResourceTypeAfterAcquisition,
	needsResourcePlatformAcquisition,
	resourceIdentityDisplayLabel,
	resourceIdentityForDetectedPlatform,
	resourceIdentityWithAcademic,
} from '../src/shared/resource-types.ts';
import { withPdfExtractionMetadata } from '../src/shared/types.ts';
import { detectResourcePlatform } from '../src/shared/url.ts';

const legacyMatrix = {
	web: { kind: 'document', resourcePlatform: null },
	rss: { kind: 'document', resourcePlatform: null },
	twitter: { kind: 'post', resourcePlatform: 'twitter' },
	youtube: { kind: 'video', resourcePlatform: 'youtube' },
	hackernews: { kind: 'document', resourcePlatform: 'hackernews' },
	pdf: { kind: 'document', resourcePlatform: null },
	image: { kind: 'image', resourcePlatform: null },
	file: { kind: 'file', resourcePlatform: null },
};

for (const [legacyType, identity] of Object.entries(legacyMatrix)) {
	assert.deepEqual(legacyResourceIdentity(legacyType), identity, `${legacyType} identity`);
}

assert.deepEqual(resourceIdentityWithAcademic(legacyMatrix.web, true), { kind: 'paper', resourcePlatform: null });
assert.deepEqual(resourceIdentityWithAcademic(legacyMatrix.hackernews, true), {
	kind: 'paper',
	resourcePlatform: 'hackernews',
});
assert.deepEqual(resourceIdentityWithAcademic(legacyMatrix.twitter, true), legacyMatrix.twitter);
assert.equal(resourceIdentityDisplayLabel(legacyMatrix.hackernews), 'Hacker News');
assert.equal(resourceIdentityDisplayLabel(legacyMatrix.twitter), 'Twitter');
assert.equal(resourceIdentityDisplayLabel(legacyMatrix.web), 'Document');
assert.equal(resourceIdentityDisplayLabel({ kind: 'paper', resourcePlatform: null }), 'Paper');
assert.equal(legacyResourceTypeAfterAcquisition('rss', 'web'), 'rss');
assert.equal(legacyResourceTypeAfterAcquisition('rss', 'hackernews'), 'hackernews');
assert.equal(legacyResourceTypeAfterAcquisition('pdf', 'web'), 'web');

const translationCases = [
	['generic document', { kind: 'document', resourcePlatform: null, fileType: null }, true],
	['Hacker News PDF', { kind: 'document', resourcePlatform: 'hackernews', fileType: 'application/pdf' }, true],
	['direct PDF', { kind: 'document', resourcePlatform: null, fileType: 'application/pdf' }, false],
	['post', { kind: 'post', resourcePlatform: 'twitter', fileType: null }, true],
	['video', { kind: 'video', resourcePlatform: 'youtube', fileType: null }, false],
	['web paper', { kind: 'paper', resourcePlatform: null, fileType: null }, true],
	['direct PDF paper', { kind: 'paper', resourcePlatform: null, fileType: 'application/pdf' }, false],
	['image', { kind: 'image', resourcePlatform: null, fileType: 'image/png' }, false],
	['file', { kind: 'file', resourcePlatform: null, fileType: 'text/csv' }, false],
];

for (const [label, identity, expected] of translationCases) {
	assert.equal(isResourceTranslationIdentityEligible(identity), expected, `${label} translation eligibility`);
}

assert.equal(detectResourcePlatform('https://x.com/openai/status/1234567890'), 'twitter');
assert.equal(detectResourcePlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
assert.equal(detectResourcePlatform('https://news.ycombinator.com/item?id=12345678'), 'hackernews');
assert.equal(detectResourcePlatform('https://example.com/article'), null);

assert.deepEqual(resourceIdentityForDetectedPlatform('twitter'), { kind: 'post', resourcePlatform: 'twitter' });
assert.deepEqual(resourceIdentityForDetectedPlatform('youtube'), { kind: 'video', resourcePlatform: 'youtube' });
assert.deepEqual(resourceIdentityForDetectedPlatform('hackernews'), { kind: 'document', resourcePlatform: 'hackernews' });
assert.deepEqual(resourceIdentityForDetectedPlatform('hackernews', true), {
	kind: 'paper',
	resourcePlatform: 'hackernews',
});

const platformAcquisitionCases = [
	['pending Twitter', { resourcePlatform: 'twitter', platformData: null }, true],
	['pending YouTube', { resourcePlatform: 'youtube', platformData: null }, true],
	['pending Hacker News', { resourcePlatform: 'hackernews', platformData: null }, true],
	['complete Twitter', { resourcePlatform: 'twitter', platformData: { tweetId: '123' } }, false],
	['generic document', { resourcePlatform: null, platformData: null }, false],
];

for (const [label, resource, expected] of platformAcquisitionCases) {
	assert.equal(needsResourcePlatformAcquisition(resource), expected, `${label} platform acquisition`);
}

const oldSnapshot = {
	fetchedAt: '2026-07-28T00:00:00.000Z',
	sourceSnapshotHash: 'old',
};
const newSnapshot = {
	fetchedAt: '2026-07-28T00:01:00.000Z',
	sourceSnapshotHash: 'new',
};
assert.equal(isIncomingResourceSnapshotSuperseded(oldSnapshot, newSnapshot), true);
assert.equal(isIncomingResourceSnapshotSuperseded(newSnapshot, oldSnapshot), false);
assert.equal(isIncomingResourceSnapshotSuperseded(newSnapshot, newSnapshot), false);
assert.equal(isIncomingResourceSnapshotSuperseded({}, newSnapshot), true);
assert.equal(
	isIncomingResourceSnapshotSuperseded({ ...oldSnapshot, sourceSnapshotHash: 'same' }, { ...newSnapshot, sourceSnapshotHash: 'same' }),
	true,
);

const pdfPlatformMetadata = {
	fetchedAt: '2026-07-28T00:00:00.000Z',
	data: null,
	representation: { fileName: 'paper.pdf', fileSize: 1024 },
};
const pdfExtraction = { status: 'needs_ocr', parser: 'liteparse', chars: 3, pages: 2 };
assert.deepEqual(withPdfExtractionMetadata(pdfPlatformMetadata, pdfExtraction), {
	...pdfPlatformMetadata,
	extraction: pdfExtraction,
});
assert.equal(withPdfExtractionMetadata(pdfPlatformMetadata, undefined), pdfPlatformMetadata);

console.info({
	event: 'resource_identity_smoke_passed',
	legacyCases: Object.keys(legacyMatrix).length,
	displayLabelCases: 4,
	detectedPlatformIdentityCases: 4,
	legacyTypeCases: 3,
	platformAcquisitionCases: platformAcquisitionCases.length,
	pdfExtractionCases: 2,
	snapshotCasCases: 5,
	translationCases: translationCases.length,
	urlCases: 4,
});
