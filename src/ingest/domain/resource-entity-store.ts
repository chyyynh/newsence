import type { CoreDb } from '@db/client';
import { entities, entityTranslations, resourceEntities } from '@db/schema';
import { canonicalizeEntityName, normalizeResourceEntitiesForStorage, type ResourceEntityInput } from '@entities/normalize';
import { and, eq, inArray, not, sql } from 'drizzle-orm';
import type { ResourceTranslationSource, ResourceType } from '../../resources/types';

export async function syncResourceEntities(
	db: CoreDb,
	resourceId: string,
	inputEntities: ResourceEntityInput[],
	resourceType: ResourceType,
	source?: string | null,
	platformMetadata?: unknown,
): Promise<void> {
	const { normalizedEntities, entityIds } = await upsertEntityIds(db, inputEntities, resourceType, source, platformMetadata);

	if (entityIds.length) {
		await db
			.delete(resourceEntities)
			.where(and(eq(resourceEntities.resourceId, resourceId), not(inArray(resourceEntities.entityId, entityIds))));
	} else {
		await db.delete(resourceEntities).where(eq(resourceEntities.resourceId, resourceId));
	}

	for (const entityId of entityIds) {
		await db.insert(resourceEntities).values({ resourceId, entityId }).onConflictDoNothing();
	}

	console.info({
		tag: 'ENTITIES',
		msg: 'Synced resource links',
		resourceId,
		inputCount: inputEntities.length,
		count: normalizedEntities.length,
		filteredCount: inputEntities.length - normalizedEntities.length,
	});
}

async function upsertEntityIds(
	db: CoreDb,
	inputEntities: ResourceEntityInput[],
	resourceType: ResourceType,
	source?: string | null,
	platformMetadata?: unknown,
): Promise<{ normalizedEntities: ResourceEntityInput[]; entityIds: string[] }> {
	const normalizedEntities = normalizeResourceEntitiesForStorage(inputEntities, resourceType, source, platformMetadata);
	const entityIds: string[] = [];

	for (const entity of normalizedEntities) {
		const canonical = canonicalizeEntityName(entity.name);
		if (!canonical) continue;

		const [row] = await db
			.insert(entities)
			.values({ canonicalName: canonical, name: entity.name, type: entity.type })
			.onConflictDoUpdate({
				target: entities.canonicalName,
				set: {
					name: entity.name,
					type: entity.type,
					updatedAt: sql`NOW()`,
				},
			})
			.returning({ id: entities.id });
		const entityId = row?.id;
		if (!entityId) throw new Error(`Failed to sync entity ${canonical}: no entity id returned`);
		entityIds.push(entityId);
		await upsertEntityTranslationRows(db, entityId, entity);
	}

	return { normalizedEntities, entityIds };
}

async function upsertEntityTranslationRows(db: CoreDb, entityId: string, entity: ResourceEntityInput): Promise<void> {
	const labels: Array<{ lang: string; name: string; source: ResourceTranslationSource }> = [
		{ lang: 'en', name: entity.name, source: 'original' },
	];
	if (entity.name_cn.trim()) labels.push({ lang: 'zh-Hant', name: entity.name_cn, source: 'machine' });

	for (const label of labels) {
		await db
			.insert(entityTranslations)
			.values({ entityId, lang: label.lang, name: label.name, source: label.source })
			.onConflictDoUpdate({
				target: [entityTranslations.entityId, entityTranslations.lang],
				set: {
					name: sql`CASE
						WHEN ${entityTranslations.source} = 'human' AND excluded.source <> 'human' THEN ${entityTranslations.name}
						ELSE COALESCE(NULLIF(excluded.name, ''), ${entityTranslations.name})
					END`,
					source: sql`CASE
						WHEN ${entityTranslations.source} = 'human' AND excluded.source <> 'human' THEN ${entityTranslations.source}
						WHEN ${entityTranslations.source} = 'original' THEN ${entityTranslations.source}
						ELSE excluded.source
					END`,
					updatedAt: sql`NOW()`,
				},
			});
	}
}
