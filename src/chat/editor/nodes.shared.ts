// Mirrors frontend/src/components/editor/core/nodes.shared.ts — same list,
// same order, so JSON state serialized by either writer parses on the other.

import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { HorizontalRuleNode } from '@lexical/extension';
import { AutoLinkNode, LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import type { Klass, LexicalNode } from 'lexical';
import { ImageNode } from './imageNode';

export const SHARED_NODES: Klass<LexicalNode>[] = [
	HeadingNode,
	QuoteNode,
	ListNode,
	ListItemNode,
	LinkNode,
	AutoLinkNode,
	CodeNode,
	CodeHighlightNode,
	HorizontalRuleNode,
	TableNode,
	TableRowNode,
	TableCellNode,
	ImageNode,
];
