// Mirrors frontend/src/components/editor/core/markdownTransformers.ts.
// Custom transformers come first so IMAGE wins over the built-in LINK
// matcher (both match the `[...](...)` shape).

import { $createHorizontalRuleNode, HorizontalRuleNode } from '@lexical/extension';
import { type ElementTransformer, type TextMatchTransformer, TRANSFORMERS, type Transformer } from '@lexical/markdown';
import { $createTextNode, $isTextNode, type LexicalNode, TextNode } from 'lexical';
import { decodeImageMarkdownTitle, encodeImageMarkdownTitle } from './imageMarkdownMeta';
import { $createImageNode, $isImageNode, ImageNode } from './imageNode';

const escapeImageAlt = (alt: string) => alt.replace(/\]/g, '\\]');
const escapeImageSrc = (src: string) => src.replace(/[\s)]/g, encodeURIComponent);

export const IMAGE_TRANSFORMER: TextMatchTransformer = {
	dependencies: [ImageNode],
	export: (node: LexicalNode) => {
		if (!$isImageNode(node)) return null;
		const title = encodeImageMarkdownTitle({
			width: node.getWidth(),
			height: node.getHeight(),
			alignment: node.getAlignment(),
			caption: node.getCaption(),
			showCaption: node.getShowCaption(),
			isFullWidth: node.getIsFullWidth(),
			cropX: node.getCropX(),
			cropY: node.getCropY(),
			cropScale: node.getCropScale(),
		});
		const alt = escapeImageAlt(node.getAltText());
		const src = escapeImageSrc(node.getSrc());
		return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
	},
	importRegExp: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\)/,
	regExp: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\)$/,
	replace: (textNode, match) => {
		const [, alt, src, titleDouble, titleSingle, titleParen] = match;
		if (!src) return;
		const title = titleDouble ?? titleSingle ?? titleParen;
		const meta = decodeImageMarkdownTitle(title);
		textNode.replace(
			$createImageNode({
				altText: alt || '',
				src,
				width: meta?.width ?? undefined,
				height: meta?.height ?? undefined,
				alignment: meta?.alignment ?? 'center',
				caption: meta?.caption ?? '',
				showCaption: meta?.showCaption ?? false,
				isFullWidth: meta?.isFullWidth ?? false,
				cropX: meta?.cropX ?? 0,
				cropY: meta?.cropY ?? 0,
				cropScale: meta?.cropScale ?? 1,
			}),
		);
	},
	trigger: ')',
	type: 'text-match',
};

export const UNDERLINE_TRANSFORMER: TextMatchTransformer = {
	dependencies: [TextNode],
	export: (node) => {
		if (!$isTextNode(node) || !node.hasFormat('underline')) return null;
		const text = node.getTextContent();
		if (!text) return null;
		const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
		return `<u>${escaped}</u>`;
	},
	importRegExp: /<u>(.*?)<\/u>/,
	regExp: /<u>(.*?)<\/u>/,
	replace: (textNode, match) => {
		const text = (match[1] ?? '')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, '&');
		const underlineNode = $createTextNode(text);
		underlineNode.setFormat(textNode.getFormat());
		underlineNode.toggleFormat('underline');
		textNode.replace(underlineNode);
		return underlineNode;
	},
	trigger: '>',
	type: 'text-match',
};

export const HORIZONTAL_RULE_TRANSFORMER: ElementTransformer = {
	dependencies: [HorizontalRuleNode],
	export: (node: LexicalNode) => {
		if (node instanceof HorizontalRuleNode) return '---';
		return null;
	},
	regExp: /^(?:---|\*\*\*|___)\s*$/,
	replace: (parentNode, _children, _match, isImport) => {
		const hrNode = $createHorizontalRuleNode();
		if (isImport || parentNode.getNextSibling()) {
			parentNode.replace(hrNode);
		} else {
			parentNode.insertBefore(hrNode);
		}
		hrNode.selectNext();
	},
	type: 'element',
};

export const EDITOR_TRANSFORMERS: Transformer[] = [IMAGE_TRANSFORMER, UNDERLINE_TRANSFORMER, HORIZONTAL_RULE_TRANSFORMER, ...TRANSFORMERS];
