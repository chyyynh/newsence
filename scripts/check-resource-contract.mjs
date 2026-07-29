import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = [];

function read(relativePath) {
	return readFileSync(path.join(root, relativePath), 'utf8');
}

function sourceFiles(directory) {
	return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
		const relativePath = path.join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(relativePath);
		return entry.isFile() && entry.name.endsWith('.ts') ? [relativePath] : [];
	});
}

function requireText(relativePath, source, text, message) {
	if (!source.includes(text)) errors.push(`${relativePath}: ${message}`);
}

function reject(relativePath, source, pattern, message) {
	if (pattern.test(source)) errors.push(`${relativePath}: ${message}`);
}

for (const relativePath of sourceFiles('src')) {
	const source = read(relativePath);
	reject(
		relativePath,
		source,
		/\b(?:ContentResourceType|ResourceType|legacyResourceIdentity|legacyResourceTypeAfterAcquisition|legacyResourceIdentityFilterCases)\b/,
		'retired resource type vocabulary remains',
	);
	reject(relativePath, source, /\b(?:resources|r|rl)\.type\b|\btype\s+AS\s+legacy_type\b/i, 'runtime SQL still reads resources.type');
	reject(
		relativePath,
		source,
		/\b(?:AI_SEARCH_NEXT|RESOURCE_IDENTITY_BACKFILL_WORKFLOW|SEARCH_INDEX_SHADOW_REBUILD_WORKFLOW)\b/,
		'retired rollout binding remains',
	);
}

const guard = read('src/db/resource-write-guard.ts');
requireText(
	'src/db/resource-write-guard.ts',
	guard,
	"to_regclass('migration_guards.resource_writes_251') IS NULL",
	'write guard must fail closed against migration_guards.resource_writes_251',
);
requireText(
	'src/db/resource-write-guard.ts',
	guard,
	'resource writes are frozen for #251',
	'write guard error must match the database freeze trigger',
);

const index = read('src/index.ts');
for (const required of [
	'shouldDispatchResourceWriters',
	"assertResourceWritesEnabled(this.env, 'enqueue resource processing RPC')",
	"assertResourceWritesEnabled(this.env, 'resync resource RPC')",
	'probeSearchIndexCutover',
]) {
	requireText('src/index.ts', index, required, `missing guarded/operator surface: ${required}`);
}

const aiSearch = read('src/ai-search.ts');
for (const required of [
	'function searchIndexQueueDrained',
	'searchIndexQueueDrained(last.ownedStatuses)',
	'last.ownedStatuses.outdated > 0',
]) {
	requireText(
		'src/ai-search.ts',
		aiSearch,
		required,
		`canonical rebuild must surface repairable outdated items after queue drain: ${required}`,
	);
}

const resourceStore = read('src/ingest/domain/resource-store.ts');
for (const required of [
	"assertResourceWritesEnabledInDb(db, 'update processed resource')",
	"assertResourceWritesEnabledInDb(db, 'upsert pending source resource')",
	"assertResourceWritesEnabledInDb(db, 'attach monitored source to resources')",
]) {
	requireText('src/ingest/domain/resource-store.ts', resourceStore, required, `missing store write guard: ${required}`);
}

const wrangler = read('wrangler.jsonc');
for (const required of [
	'"binding": "RESOURCE_PROCESSING_V2_WORKFLOW"',
	'"name": "newsence-resource-processing-v2"',
	'"class_name": "ResourceProcessingV2Workflow"',
	'"binding": "RESOURCE_TRANSLATION_V2_WORKFLOW"',
	'"name": "newsence-resource-translation-v2"',
	'"class_name": "ResourceTranslationV2Workflow"',
	'"binding": "SEARCH_INDEX_CANONICAL_REBUILD_WORKFLOW"',
	'"name": "newsence-search-index-canonical-v6-rebuild"',
	'"class_name": "SearchIndexCanonicalV6RebuildWorkflow"',
	'"binding": "RECENT_RESOURCE_IMAGE_BACKFILL_V2_WORKFLOW"',
	'"name": "newsence-recent-resource-image-backfill-v2"',
	'"class_name": "RecentResourceImageBackfillV2Workflow"',
	'"binding": "ACADEMIC_METADATA_BACKFILL_V3_WORKFLOW"',
	'"name": "newsence-academic-metadata-backfill-v3"',
	'"class_name": "AcademicMetadataBackfillV3Workflow"',
	'"instance_name": "newsence-corpus-v6"',
]) {
	requireText('wrangler.jsonc', wrangler, required, `missing canonical binding contract: ${required}`);
}
reject(
	'wrangler.jsonc',
	wrangler,
	/\b(?:AI_SEARCH_NEXT|RECENT_RESOURCE_IMAGE_BACKFILL_WORKFLOW|RESOURCE_IDENTITY_BACKFILL_WORKFLOW|SEARCH_INDEX_SHADOW_REBUILD_WORKFLOW)\b/,
	'retired rollout binding remains',
);
reject(
	'wrangler.jsonc',
	wrangler,
	/"name": "newsence-recent-resource-image-backfill"|"class_name": "RecentResourceImageBackfillWorkflow"/,
	'retired recent-image Workflow physical resource remains',
);

if (errors.length > 0) {
	console.error('Core canonical resource contract check failed:');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

process.stdout.write(`Core canonical resource contract check passed across ${sourceFiles('src').length} source files.\n`);
