// Mirrors frontend/src/lib/editor/serverEditor.ts. Both writers must produce
// identical JSONB so a row written here reads back correctly through the
// Vercel inline route (and vice versa).

import { createHeadlessEditor } from '@lexical/headless';
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown';
import { $createParagraphNode, $getRoot } from 'lexical';
import { EDITOR_TRANSFORMERS } from './markdownTransformers';
import { SHARED_NODES } from './nodes.shared';

function createServerEditor() {
	return createHeadlessEditor({
		nodes: SHARED_NODES,
		onError: (error) => console.error('[serverEditor]', error),
	});
}

export function markdownToLexicalJson(markdown: string): object {
	const editor = createServerEditor();
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			$convertFromMarkdownString(markdown, EDITOR_TRANSFORMERS);
			if (root.getChildrenSize() === 0) root.append($createParagraphNode());
		},
		{ discrete: true },
	);
	return editor.getEditorState().toJSON();
}

export function lexicalJsonToMarkdown(json: object): string {
	const editor = createServerEditor();
	const state = editor.parseEditorState(JSON.stringify(json));
	editor.setEditorState(state);

	let markdown = '';
	editor.getEditorState().read(() => {
		markdown = $convertToMarkdownString(EDITOR_TRANSFORMERS);
	});
	return markdown;
}

export function contentToMarkdown(content: unknown): string {
	if (content === null || content === undefined) return '';
	if (typeof content === 'string') return content;
	if (typeof content === 'object') return lexicalJsonToMarkdown(content as object);
	return String(content);
}
