/**
 * load-skill tool — Phase 4 port of frontend/src/lib/ai/tools/load-skill.ts.
 *
 * Returns skill content by id. The tool description lists every available
 * skill so the model can pick one mid-conversation without an external
 * catalog call.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getSkill, getUserSkillMetas } from '../skills';

export function createLoadSkillTool() {
	const metas = getUserSkillMetas();
	const validIds = new Set(metas.map((m) => m.id));
	const skillList = metas.map((m) => `- ${m.id}: ${m.description}`).join('\n');

	return tool({
		description: ['Load a skill to get detailed instructions for a specific task.', 'Available skills:', skillList].join('\n'),
		inputSchema: z.object({
			skillId: z.string().describe('The skill ID to load'),
		}),
		execute: async ({ skillId }) => {
			if (!validIds.has(skillId)) {
				return { ok: false, error: `Unknown skill: ${skillId}. Available: ${[...validIds].join(', ')}` };
			}
			const skill = getSkill(skillId);
			return { ok: true, content: skill?.content ?? '' };
		},
	});
}
