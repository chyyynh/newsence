/**
 * Builtin skills registry — Phase 4 port of frontend/src/lib/ai/skills/index.ts.
 *
 * Skills are curated prompt presets the agent self-loads via `load-skill`.
 * Pure data + a Map lookup — no DB, no AI SDK, no async. Safe to keep in
 * sync by hand for now; if drift becomes an issue we can extract to a
 * shared package.
 *
 * Subset note: only the 3 simplest user-pickable skills are ported here.
 * `daily-ai-report` and `deep-research` reference tools that aren't on the
 * worker yet (generate-image, search-news, search-web, read-context,
 * create-document, add-resource); they'll be added back once those tools
 * land in Phase 5+ of issue #136.
 */

export interface SkillMeta {
	id: string;
	description: string;
	inject: 'user' | 'system';
	tools?: readonly string[];
	systemPromptOverride?: boolean;
}

export interface SkillDefinition {
	meta: SkillMeta;
	content: string;
}

export const BUILTIN_SKILLS = [
	{
		meta: { id: 'article-rewrite', description: 'Rewrite material into a structured article', inject: 'user' },
		content: [
			'You are a senior tech editor. Rewrite the provided material into a well-structured, readable article.',
			'',
			'## Output Format',
			'# {Title}',
			'> {One-sentence overview, under 25 words}',
			'',
			'## {Section Title}',
			'{100-180 words per section; preserve key data and direct quotes}',
			'',
			'## Conclusion',
			'{40-80 words, summarize key points and outlook}',
			'',
			'## Writing Rules',
			'- Logical flow between paragraphs; no repeated information',
			'- Do not invent facts; mark gaps with "[Unverified]"',
			'- Keep original numbers when citing data',
			'- Output Markdown only — no preamble or postscript',
		].join('\n'),
	},
	{
		meta: { id: 'summary', description: 'Generate a structured summary with key points and data', inject: 'user' },
		content: [
			'You are a professional analyst. Generate a structured summary from the provided content.',
			'',
			'## Output Format',
			'### Key Points',
			'- {3-5 bullet points, one sentence each}',
			'',
			'### Key Data',
			'- {List important numbers, percentages, and figures from the text}',
			'',
			'### Conclusions & Impact',
			'{2-3 sentences summarizing conclusions and potential implications}',
			'',
			'## Rules',
			'- Total length under 300 words',
			'- Prioritize conclusions and concrete numbers',
			'- Do not speculate or fabricate; mark gaps with "[Not in source]"',
			'- Output Markdown only — no preamble',
		].join('\n'),
	},
	{
		meta: { id: 'social-content', description: 'Generate a social media post under 280 characters', inject: 'user' },
		content: [
			'You are a tech social media manager. Generate a single post from the provided content.',
			'',
			'## Rules',
			'- Strictly under 280 characters total (including hashtags)',
			'- Output ONLY the post body — no preamble, postscript, or explanations',
			'- Include 2-3 relevant hashtags',
			'- Third-person, objective reporting tone',
			'- No emojis',
			'- Keep technical terms as-is',
			'- Do not exaggerate or fabricate',
		].join('\n'),
	},
] as const satisfies readonly SkillDefinition[];

const SKILL_MAP = new Map<string, SkillDefinition>(BUILTIN_SKILLS.map((s) => [s.meta.id, s]));

export function getSkill(id: string): SkillDefinition | undefined {
	return SKILL_MAP.get(id);
}

/** User-pickable skills (drive the load-skill tool catalog). */
export function getUserSkillMetas(): SkillMeta[] {
	return BUILTIN_SKILLS.filter((s) => s.meta.inject === 'user').map((s) => ({ ...s.meta }));
}
