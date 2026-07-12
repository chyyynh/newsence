// Entity normalization & storage filtering (pure, no DB access)
//
// Everything that decides WHICH extracted entities are worth
// storing and under WHAT canonical key. Consumed by the ingest
// pipeline (persistence + prompt exclusion lists).

import type { ContentResourceType } from '@core-shared/resource-types';
import { ENTITY_TYPES, type EntityType } from '@core-shared/types';

export type ResourceEntityInput = { name: string; name_cn: string; type: string };
type NormalizedResourceEntity = { name: string; name_cn: string; type: EntityType };

/** Canonical names that are too generic to be useful entity pages (audit 2026-07-02, issue #197). */
const GENERIC_ENTITY_CANONICALS = new Set(['ai', 'x', 'go', 'us', 'c', 'v4', 'rl', 'pi']);
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const ASCII_TICKER_ENTITY_RE = /^\$[a-z]{1,5}$/i;
const SOURCE_FEED_SUFFIX_CANONICALS = new Set([
	'ai',
	'article',
	'articles',
	'blog',
	'business',
	'crypto',
	'finance',
	'news',
	'research',
	'rss',
	'startup',
	'startups',
	'tech',
	'technology',
]);
const ENTITY_NAME_MAX_LENGTH = 255;
const ENTITY_TYPE_MAX_LENGTH = 20;
const MAX_ENTITIES_PER_RESOURCE = 10;
const MAX_EXCLUSION_NAMES = 10;

// Trailing side strips quotes only: `.`/`)`/`}`/`!` can be part of legit
// names (u.s., snap inc., model context protocol (mcp), safe{wallet}, yahoo!).
export function canonicalizeEntityName(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKC')
		.replace(/\s+/g, ' ')
		.replace(/^[\s"'`“”‘’([{]+|[\s"'`“”‘’]+$/g, '')
		.trim();
}

function shouldStoreResourceEntity(entity: NormalizedResourceEntity, excludedCanonicalNames: ReadonlySet<string>): boolean {
	const canonical = canonicalizeEntityName(entity.name);
	if (!canonical || /^[a-z0-9]{1,2}$/i.test(canonical)) return false;
	if (canonical.length > ENTITY_NAME_MAX_LENGTH || entity.name.length > ENTITY_NAME_MAX_LENGTH) return false;
	if (entity.name_cn.length > ENTITY_NAME_MAX_LENGTH || entity.type.length > ENTITY_TYPE_MAX_LENGTH) return false;
	if (ASCII_TICKER_ENTITY_RE.test(canonical)) return false;
	if (GENERIC_ENTITY_CANONICALS.has(canonical)) return false;
	return !excludedCanonicalNames.has(canonical);
}

function normalizeEntityType(value: string): EntityType | null {
	const type = value.trim().toLowerCase();
	return ENTITY_TYPE_SET.has(type) ? (type as EntityType) : null;
}

function normalizeResourceEntity(entity: ResourceEntityInput): NormalizedResourceEntity | null {
	const name = entity.name.trim();
	const nameCn = entity.name_cn.trim();
	const type = normalizeEntityType(entity.type);
	if (!name || !type) return null;
	return {
		name,
		name_cn: nameCn,
		type,
	};
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sourceNameAliases(source?: string | null): string[] {
	const value = stringValue(source);
	if (!value) return [];
	const aliases = [value, ...sourceFeedBaseAliases(value)];

	const host = hostFromSource(value);
	if (host) {
		aliases.push(host);
		const labels = host.replace(/^www\./, '').split('.');
		if (labels.length > 1 && labels[0]) aliases.push(labels[0]);
	}
	return aliases;
}

function sourceFeedBaseAliases(value: string): string[] {
	const match = value.match(/^(.+?)\s+[-–—|:]\s+(.+)$/);
	if (!match) return [];
	const [, base, suffix] = match;
	const suffixTokens = canonicalizeEntityName(suffix)
		.split(/[\s/]+/)
		.filter(Boolean);
	if (!suffixTokens.length || !suffixTokens.every((token) => SOURCE_FEED_SUFFIX_CANONICALS.has(token))) return [];
	const alias = base.trim();
	return alias ? [alias] : [];
}

function hostFromSource(value: string): string | null {
	try {
		return new URL(value.includes('://') ? value : `https://${value}`).hostname.replace(/^www\./, '');
	} catch {
		return null;
	}
}

function platformMetadataSourceAliases(resourceType: ContentResourceType, metadata: unknown): string[] {
	const envelope = recordValue(metadata);
	const data = recordValue(envelope?.data);
	if (!data) return [];
	const aliases: string[] = [];
	const add = (value: unknown) => {
		const str = stringValue(value);
		if (str) aliases.push(str);
	};

	if (resourceType === 'twitter') {
		add(data.authorName);
		const userName = stringValue(data.authorUserName);
		if (userName) aliases.push(userName, `@${userName}`);
		aliases.push('Twitter', 'X');
	} else if (resourceType === 'youtube') {
		add(data.channelName);
		aliases.push('YouTube');
	} else if (resourceType === 'hackernews') {
		add(data.author);
		aliases.push('Hacker News');
	}
	return aliases;
}

function excludedEntityCanonicalNames(resourceType: ContentResourceType, source?: string | null, platformMetadata?: unknown): Set<string> {
	const names = entityExtractionExclusionNames(resourceType, source, platformMetadata);
	return new Set(names.map(canonicalizeEntityName).filter(Boolean));
}

export function entityExtractionExclusionNames(
	resourceType: ContentResourceType,
	source?: string | null,
	platformMetadata?: unknown,
): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const name of [...sourceNameAliases(source), ...platformMetadataSourceAliases(resourceType, platformMetadata)]) {
		const canonical = canonicalizeEntityName(name);
		if (!canonical || seen.has(canonical)) continue;
		seen.add(canonical);
		names.push(name.trim());
		if (names.length >= MAX_EXCLUSION_NAMES) break;
	}
	return names;
}

export function normalizeResourceEntitiesForStorage(
	entities: ResourceEntityInput[],
	resourceType: ContentResourceType,
	source?: string | null,
	platformMetadata?: unknown,
): NormalizedResourceEntity[] {
	const byCanonical = new Map<string, NormalizedResourceEntity>();
	const excludedCanonicals = excludedEntityCanonicalNames(resourceType, source, platformMetadata);
	for (const entity of entities) {
		const normalized = normalizeResourceEntity(entity);
		if (!normalized) continue;
		const canonical = canonicalizeEntityName(normalized.name);
		if (!canonical || byCanonical.has(canonical) || !shouldStoreResourceEntity(normalized, excludedCanonicals)) continue;
		byCanonical.set(canonical, normalized);
		if (byCanonical.size >= MAX_ENTITIES_PER_RESOURCE) break;
	}
	return [...byCanonical.values()];
}

export function normalizeResourceEntityUpdatePayload(
	updatePayload: { entities?: unknown },
	resourceType: ContentResourceType,
	source?: string | null,
	platformMetadata?: unknown,
): NormalizedResourceEntity[] | null {
	if (!Array.isArray(updatePayload.entities)) return null;
	const entities = normalizeResourceEntitiesForStorage(
		updatePayload.entities.filter(isResourceEntityInput),
		resourceType,
		source,
		platformMetadata,
	);
	updatePayload.entities = entities;
	return entities;
}

function isResourceEntityInput(value: unknown): value is ResourceEntityInput {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return typeof record.name === 'string' && typeof record.name_cn === 'string' && typeof record.type === 'string';
}
