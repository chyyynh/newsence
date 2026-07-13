#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const drizzlePath = resolve(root, 'src/db/schema.ts');
const prismaPath = resolve(root, '../../web-tanstack/prisma/schema.prisma');
const manualIndexesPath = resolve(root, '../../web-tanstack/prisma/manual-indexes.sql');
const resourceTypesPath = resolve(root, 'src/shared/resource-types.ts');

const drizzleSource = readFileSync(drizzlePath, 'utf8');
const prismaSource = readFileSync(prismaPath, 'utf8');
const manualIndexesSource = readFileSync(manualIndexesPath, 'utf8');
const resourceTypesSource = readFileSync(resourceTypesPath, 'utf8');

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
	const declaration = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`));
	if (!declaration) return null;
	return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
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

const contentResourceTypes = parseStringArray(resourceTypesSource, 'CONTENT_RESOURCE_TYPES');
const mediaResourceTypes = parseStringArray(resourceTypesSource, 'MEDIA_RESOURCE_TYPES');
if (!contentResourceTypes || !mediaResourceTypes) {
	errors.push(`Unable to parse canonical resource types from ${resourceTypesPath}`);
} else {
	const expectedResourceTypes = [...contentResourceTypes, ...mediaResourceTypes];
	if (!/type:\s*text\('type',\s*\{\s*enum:\s*RESOURCE_TYPES\s*\}\)/.test(drizzleSource)) {
		errors.push('Drizzle resources.type must use the complete canonical RESOURCE_TYPES domain');
	}
	const constraint = manualIndexesSource.match(/ADD CONSTRAINT resources_type_check\s+CHECK \(type IN \(([^)]+)\)\);/);
	const constrainedTypes = constraint ? [...constraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : null;
	if (!constrainedTypes) {
		errors.push(`Unable to parse resources_type_check from ${manualIndexesPath}`);
	} else if (!sameValues(constrainedTypes, expectedResourceTypes)) {
		errors.push(
			`resources_type_check domain [${constrainedTypes.join(', ')}] differs from canonical RESOURCE_TYPES [${expectedResourceTypes.join(', ')}]`,
		);
	}
}

const sourcePlatforms = parseStringArray(resourceTypesSource, 'SOURCE_PLATFORMS');
const sourceAcquisitionModes = parseStringArray(resourceTypesSource, 'SOURCE_ACQUISITION_MODES');
if (!sourcePlatforms || !sourceAcquisitionModes) {
	errors.push(`Unable to parse canonical source policy domains from ${resourceTypesPath}`);
} else {
	if (!/platform:\s*text\('platform',\s*\{\s*enum:\s*SOURCE_PLATFORMS\s*\}\)/.test(drizzleSource)) {
		errors.push('Drizzle sources.platform must use the canonical SOURCE_PLATFORMS domain');
	}
	if (!/acquisitionMode:\s*text\('content_mode',\s*\{\s*enum:\s*SOURCE_ACQUISITION_MODES\s*\}\)/.test(drizzleSource)) {
		errors.push('Drizzle sources.acquisitionMode must use the canonical SOURCE_ACQUISITION_MODES domain');
	}
	const platformConstraint = manualIndexesSource.match(/ADD CONSTRAINT sources_platform_check\s+CHECK \(platform IN \(([^)]+)\)\);/);
	const constrainedPlatforms = platformConstraint ? [...platformConstraint[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : null;
	if (!constrainedPlatforms || !sameMembers(constrainedPlatforms, sourcePlatforms)) {
		errors.push('sources_platform_check differs from canonical SOURCE_PLATFORMS');
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
	`Drizzle/Prisma drift check passed for ${drizzleTables.length} complete table definitions and canonical resource/source domains.\n`,
);
