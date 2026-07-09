#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const drizzlePath = resolve(root, 'src/db/schema.ts');
const prismaPath = resolve(root, '../../web-tanstack/prisma/schema.prisma');

const drizzleSource = readFileSync(drizzlePath, 'utf8');
const prismaSource = readFileSync(prismaPath, 'utf8');

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
	const tablePattern = /export const (\w+) = pgTable\('([^']+)', \{([\s\S]*?)\n\}\);/g;
	const columnPattern = /^\s*\w+:\s*\w+(?:<[^>]+>)?\('([^']+)'/gm;

	for (const match of source.matchAll(tablePattern)) {
		const [, exportName, tableName, body] = match;
		const columns = new Set();
		for (const columnMatch of body.matchAll(columnPattern)) columns.add(columnMatch[1]);
		tables.push({ exportName, tableName, columns });
	}

	return tables;
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
}

if (errors.length > 0) {
	console.error('Drizzle/Prisma schema drift detected:\n');
	for (const error of errors) console.error(`- ${error}`);
	process.exit(1);
}

process.stdout.write(`Drizzle/Prisma drift check passed for ${drizzleTables.length} core-worker table definitions.\n`);
