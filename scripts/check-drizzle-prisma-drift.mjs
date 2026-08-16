#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const drizzlePath = resolve(root, 'src/db/schema.ts');
const prismaPath = resolve(root, '../../web-tanstack/prisma/schema.prisma');
const manualIndexesPath = resolve(root, '../../web-tanstack/prisma/manual-indexes.sql');
const resourceTypesPath = resolve(root, 'src/shared/resource-types.ts');
const systemIdentitiesPath = resolve(root, 'src/shared/system-identities.ts');

const drizzleSource = readFileSync(drizzlePath, 'utf8');
const prismaSource = readFileSync(prismaPath, 'utf8');
const manualIndexesSource = readFileSync(manualIndexesPath, 'utf8');
const resourceTypesSource = readFileSync(resourceTypesPath, 'utf8');
const systemIdentitiesSource = readFileSync(systemIdentitiesPath, 'utf8');

const PRISMA_SCALARS = new Set(['String', 'Int', 'BigInt', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Bytes', 'Unsupported']);

function parsePrismaEnums(source) {
	const enums = new Set();
	const enumPattern = /enum\s+(\w+)\s*\{[\s\S]*?\n\}/g;
	for (const match of source.matchAll(enumPattern)) enums.add(match[1]);
	return enums;
}

function prismaBaseType(type) {
	return type
		.replaceAll('?', '')
		.replaceAll('[', '')
		.replaceAll(']', '')
		.replace(/^Unsupported\(.+$/, 'Unsupported');
}

function parsePrismaModels(source) {
	const enums = parsePrismaEnums(source);
	const tables = new Map();
	const modelPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;

	for (const match of source.matchAll(modelPattern)) {
		const [, modelName, body] = match;
		const tableName = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? modelName;
		const columns = new Set();

		for (const rawLine of body.split('\n')) {
			const line = rawLine.trim().replace(/\s+\/\/.*$/, '');
			if (!line || line.startsWith('//') || line.startsWith('@@')) continue;

			const [fieldName, rawType] = line.split(/\s+/, 2);
			if (!fieldName || !rawType) continue;

			const baseType = prismaBaseType(rawType);
			if (!PRISMA_SCALARS.has(baseType) && !enums.has(baseType)) continue;

			const columnName = line.match(/@map\("([^"]+)"\)/)?.[1] ?? fieldName;
			columns.add(columnName);
		}

		tables.set(tableName, { modelName, columns });
	}

	return tables;
}

function parseDrizzleTables(source) {
	const tables = [];
	const tablePattern = /export const (\w+)\s*=\s*pgTable\(\s*'([^']+)'\s*,\s*\{/g;
	const columnPattern = /^\s*\w+:\s*\w+(?:<[^>]+>)?\('([^']+)'/gm;

	for (const match of source.matchAll(tablePattern)) {
		const [, exportName, tableName] = match;
		const bodyStart = match.index + match[0].length - 1;
		const bodyEnd = findMatchingBrace(source, bodyStart);
		if (bodyEnd === -1) {
			tables.push({ exportName, tableName, columns: new Set() });
			continue;
		}
		const body = source.slice(bodyStart + 1, bodyEnd);
		const columns = new Set();
		for (const columnMatch of body.matchAll(columnPattern)) columns.add(columnMatch[1]);
		tables.push({ exportName, tableName, columns });
	}

	return tables;
}

function findMatchingBrace(source, openIndex) {
	let depth = 0;
	for (let index = openIndex; index < source.length; index++) {
		const char = source[index];
		if (char === '{') depth++;
		else if (char === '}') {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function parseStringArray(source, name) {
	const declaration = source.match(new RegExp(`(?:export )?const ${name} = \\[([^\\]]*)\\] as const`));
	if (!declaration) return null;
	return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function parseStringOrNullArrayRecord(source, name) {
	const body = source.match(new RegExp(`(?:export )?const ${name} = \\{([\\s\\S]*?)\\} as const`))?.[1];
	if (!body) return null;
	const entries = new Map();
	for (const match of body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
		const values = [...match[2].matchAll(/'([^']+)'|\b(null)\b/g)].map((value) => value[1] ?? null);
		entries.set(match[1], values);
	}
	return entries.size > 0 ? entries : null;
}

function parseObjectStringProperty(source, objectName, propertyName) {
	const objectBody = source.match(new RegExp(`export const ${objectName} = \\{([\\s\\S]*?)\\} as const`))?.[1];
	return objectBody?.match(new RegExp(`${propertyName}:\\s*'([^']+)'`))?.[1] ?? null;
}

function sqlStringValues(source) {
	return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function parseDomainConstraint(source, constraintName, columnName) {
	const match = source.match(
		new RegExp(`ADD CONSTRAINT ${constraintName}\\s+CHECK \\((?:${columnName} IS NULL OR )?${columnName} IN \\(([^)]+)\\)\\);`),
	);
	return match ? sqlStringValues(match[1]) : null;
}

function parseKindPlatformMatrixBody(body) {
	if (!body) return null;
	const pairs = [];
	for (const match of body.matchAll(/\(kind = '([^']+)' AND resource_platform (IS NULL|= '([^']+)')\)/g)) {
		pairs.push(`${match[1]}:${match[2] === 'IS NULL' ? 'null' : match[3]}`);
	}
	return {
		allowsLegacyNullPair: /\(kind IS NULL AND resource_platform IS NULL\)/.test(body),
		pairs,
	};
}

function parseConstraintKindPlatformMatrix(source) {
	const body = source.match(/ADD CONSTRAINT resources_kind_platform_check\s+CHECK\s*\(\s*\(([\s\S]*?)\)\s+IS TRUE\s*\);/)?.[1];
	return parseKindPlatformMatrixBody(body);
}

function expectedKindPlatformPairs(matrix) {
	return [...matrix.entries()].flatMap(([kind, platforms]) => platforms.map((platform) => `${kind}:${platform ?? 'null'}`));
}

function sameValues(actual, expected) {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameMembers(actual, expected) {
	return sameValues([...actual].sort(), [...expected].sort());
}

const prismaTables = parsePrismaModels(prismaSource);
const drizzleTables = parseDrizzleTables(drizzleSource);
const errors = [];

if (/^(?!\s*--)[^\r\n]*\bDROP\s+(?:TABLE|COLUMN)\b/im.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not drop tables or columns; use an explicit cutover');
}

const accountKinds = parseStringArray(systemIdentitiesSource, 'USER_ACCOUNT_KINDS');
const accountKindConstraint = manualIndexesSource.match(/ADD CONSTRAINT user_account_kind_check\s+CHECK \(account_kind IN \(([^)]+)\)\);/);
const constrainedAccountKinds = accountKindConstraint
	? [...accountKindConstraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
	: null;
if (!accountKinds || !constrainedAccountKinds || !sameValues(accountKinds, constrainedAccountKinds)) {
	errors.push('user_account_kind_check differs from canonical USER_ACCOUNT_KINDS');
}
if (!/accountKind\s+String\s+@default\("human"\)\s+@map\("account_kind"\)/.test(prismaSource)) {
	errors.push('Prisma User.accountKind must default to human and map to account_kind');
}

for (const property of ['id', 'username', 'name', 'email']) {
	const value = parseObjectStringProperty(systemIdentitiesSource, 'OPENNEWS_SYSTEM_USER', property);
	if (!value) {
		errors.push(`OPENNEWS_SYSTEM_USER.${property} is missing`);
	} else if (!manualIndexesSource.includes(`'${value}'`)) {
		errors.push(`OpenNews seed SQL does not contain OPENNEWS_SYSTEM_USER.${property}`);
	}
}
const opennewsUserId = parseObjectStringProperty(systemIdentitiesSource, 'OPENNEWS_SYSTEM_USER', 'id');
if (opennewsUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(opennewsUserId)) {
	errors.push('OPENNEWS_SYSTEM_USER.id must be a canonical UUIDv4');
}

if (drizzleTables.length === 0) errors.push(`No Drizzle pgTable definitions found in ${drizzlePath}`);

for (const table of drizzleTables) {
	const prismaTable = prismaTables.get(table.tableName);
	if (!prismaTable) {
		errors.push(`Drizzle table ${table.exportName} maps to "${table.tableName}", which is absent from Prisma schema`);
		continue;
	}

	for (const column of table.columns) {
		if (!prismaTable.columns.has(column)) {
			errors.push(
				`Drizzle table ${table.exportName}."${column}" is absent from Prisma model ${prismaTable.modelName} (${table.tableName})`,
			);
		}
	}
	for (const column of prismaTable.columns) {
		if (!table.columns.has(column)) {
			errors.push(
				`Prisma model ${prismaTable.modelName}."${column}" is absent from Drizzle table ${table.exportName} (${table.tableName})`,
			);
		}
	}
}

if (/\bRESOURCE_TYPES\b|type:\s*text\('type'/.test(drizzleSource)) {
	errors.push('Drizzle resources must not expose the retired type column/domain');
}
if (/resources_type_check/.test(manualIndexesSource)) {
	errors.push('manual-indexes.sql must not recreate resources_type_check');
}

const resourceKinds = parseStringArray(resourceTypesSource, 'RESOURCE_KINDS');
const resourcePlatforms = parseStringArray(resourceTypesSource, 'RESOURCE_PLATFORMS');
const validKindPlatforms = parseStringOrNullArrayRecord(resourceTypesSource, 'VALID_KIND_PLATFORMS');
if (!resourceKinds || !resourcePlatforms || !validKindPlatforms) {
	errors.push(`Unable to parse canonical resource identity domains from ${resourceTypesPath}`);
} else {
	const matrixKinds = [...validKindPlatforms.keys()];
	if (!sameMembers(matrixKinds, resourceKinds)) {
		errors.push('VALID_KIND_PLATFORMS keys differ from canonical RESOURCE_KINDS');
	}
	const unknownMatrixPlatforms = [...validKindPlatforms.values()]
		.flat()
		.filter((platform) => platform !== null && !resourcePlatforms.includes(platform));
	if (unknownMatrixPlatforms.length > 0) {
		errors.push(`VALID_KIND_PLATFORMS contains unknown platforms: ${[...new Set(unknownMatrixPlatforms)].join(', ')}`);
	}

	if (!/kind:\s*text\('kind',\s*\{\s*enum:\s*RESOURCE_KINDS\s*\}\)\.notNull\(\),/.test(drizzleSource)) {
		errors.push('Drizzle resources.kind must be required and use the canonical RESOURCE_KINDS domain');
	}
	if (!/resourcePlatform:\s*text\('resource_platform',\s*\{\s*enum:\s*RESOURCE_PLATFORMS\s*\}\),/.test(drizzleSource)) {
		errors.push('Drizzle resources.resourcePlatform must be nullable and use the canonical RESOURCE_PLATFORMS domain');
	}

	const resourceModelBody = prismaSource.match(/model Resource \{([\s\S]*?)\n\}/)?.[1] ?? '';
	if (!/^\s*kind\s+String\s*$/m.test(resourceModelBody)) {
		errors.push('Prisma Resource.kind must be required and have no default');
	}
	if (!/^\s*resourcePlatform\s+String\?\s+@map\("resource_platform"\)\s*$/m.test(resourceModelBody)) {
		errors.push('Prisma Resource.resourcePlatform must be nullable, mapped to resource_platform, and have no default');
	}

	const expectedPairs = expectedKindPlatformPairs(validKindPlatforms);
	const constrainedKinds = parseDomainConstraint(manualIndexesSource, 'resources_kind_check', 'kind');
	if (!constrainedKinds || !sameValues(constrainedKinds, resourceKinds)) {
		errors.push('manual-indexes.sql resources_kind_check differs from canonical RESOURCE_KINDS');
	}
	const constrainedPlatforms = parseDomainConstraint(manualIndexesSource, 'resources_resource_platform_check', 'resource_platform');
	if (!constrainedPlatforms || !sameValues(constrainedPlatforms, resourcePlatforms)) {
		errors.push('manual-indexes.sql resources_resource_platform_check differs from canonical RESOURCE_PLATFORMS');
	}
	const matrix = parseConstraintKindPlatformMatrix(manualIndexesSource);
	if (!matrix || matrix.allowsLegacyNullPair || !sameMembers(matrix.pairs, expectedPairs)) {
		errors.push('manual-indexes.sql resources_kind_platform_check differs from canonical VALID_KIND_PLATFORMS');
	}
	if (!/r\.source_id,\s*r\.kind,\s*r\.resource_platform\s+FROM resources/.test(manualIndexesSource)) {
		errors.push('manual-indexes.sql resources_localized must append kind and resource_platform after source_id');
	}
}

const sourcePlatforms = parseStringArray(resourceTypesSource, 'SOURCE_PLATFORMS');
const sourceKinds = parseStringArray(resourceTypesSource, 'SOURCE_KINDS');
const sourceAcquisitionModes = parseStringArray(resourceTypesSource, 'SOURCE_ACQUISITION_MODES');
if (!sourcePlatforms || !sourceKinds || !sourceAcquisitionModes) {
	errors.push(`Unable to parse canonical source policy domains from ${resourceTypesPath}`);
} else {
	if (!/platform:\s*text\('platform',\s*\{\s*enum:\s*SOURCE_PLATFORMS\s*\}\)/.test(drizzleSource)) {
		errors.push('Drizzle sources.platform must use the canonical SOURCE_PLATFORMS domain');
	}
	if (!/kind:\s*text\('kind',\s*\{\s*enum:\s*SOURCE_KINDS\s*\}\)\.default\('blog'\)\.notNull\(\),/.test(drizzleSource)) {
		errors.push('Drizzle sources.kind must use the canonical SOURCE_KINDS domain and default to blog');
	}
	const sourceModelBody = prismaSource.match(/model Source \{([\s\S]*?)\n\}/)?.[1] ?? '';
	if (!/^\s*kind\s+String\s+@default\("blog"\)\s*$/m.test(sourceModelBody)) {
		errors.push('Prisma Source.kind must be required and default to blog');
	}
	if (!/acquisitionMode:\s*text\('content_mode',\s*\{\s*enum:\s*SOURCE_ACQUISITION_MODES\s*\}\)/.test(drizzleSource)) {
		errors.push('Drizzle sources.acquisitionMode must use the canonical SOURCE_ACQUISITION_MODES domain');
	}
	const platformConstraint = manualIndexesSource.match(/ADD CONSTRAINT sources_platform_check\s+CHECK \(platform IN \(([^)]+)\)\);/);
	const constrainedPlatforms = platformConstraint ? [...platformConstraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : null;
	if (!constrainedPlatforms || !sameMembers(constrainedPlatforms, sourcePlatforms)) {
		errors.push('sources_platform_check differs from canonical SOURCE_PLATFORMS');
	}
	const constrainedKinds = parseDomainConstraint(manualIndexesSource, 'sources_kind_check', 'kind');
	if (!constrainedKinds || !sameValues(constrainedKinds, sourceKinds)) {
		errors.push('sources_kind_check differs from canonical SOURCE_KINDS');
	}
	const acquisitionConstraint = manualIndexesSource.match(
		/ADD CONSTRAINT sources_acquisition_mode_check\s+CHECK \(([\s\S]*?)\n {2}\);/,
	)?.[1];
	const constrainedModes = acquisitionConstraint
		? [
				...new Set(
					[...acquisitionConstraint.matchAll(/content_mode\s+(?:IN\s+\(([^)]+)\)|=\s*'([^']+)')/g)].flatMap((match) => {
						if (match[2]) return [match[2]];
						return [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]);
					}),
				),
			]
		: null;
	if (!constrainedModes || !sameMembers(constrainedModes, sourceAcquisitionModes)) {
		errors.push('sources_acquisition_mode_check differs from canonical SOURCE_ACQUISITION_MODES');
	}
}

if (errors.length > 0) {
	console.error('Drizzle/Prisma schema drift detected:\n');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

process.stdout.write(
	`Drizzle/Prisma drift check passed for ${drizzleTables.length} complete table definitions and canonical resource/source domains and identity matrix.\n`,
);
