// Keep in sync with frontend/src/lib/ai/prompts.ts getOutputLanguageInstruction.

const OUTPUT_LANG_INSTRUCTION: Record<'zh' | 'en', string> = {
	zh: 'Respond in Traditional Chinese (繁體中文). Keep technical terms in English.',
	en: 'Respond in English.',
};

export function getOutputLanguageInstruction(language: 'zh' | 'en'): string {
	return OUTPUT_LANG_INSTRUCTION[language];
}
