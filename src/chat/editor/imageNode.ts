// Headless-only ImageNode for worker JSONB round-trip. Data fields + JSON
// shape MUST match frontend/src/components/editor/nodes/ImageNode.tsx so a
// document written by either writer reads back identically on the other;
// the DOM/React glue (createDOM/exportDOM/decorate) is omitted because
// @lexical/headless never invokes those paths.

import {
	$applyNodeReplacement,
	DecoratorNode,
	type LexicalNode,
	type LexicalUpdateJSON,
	type NodeKey,
	type SerializedLexicalNode,
} from 'lexical';

interface ImagePayload {
	src: string;
	altText: string;
	width?: number;
	height?: number;
	maxWidth?: number;
	caption?: string;
	showCaption?: boolean;
	isFullWidth?: boolean;
	cropX?: number;
	cropY?: number;
	cropScale?: number;
	alignment?: 'left' | 'center' | 'right';
	key?: NodeKey;
}

interface SerializedImageNode extends SerializedLexicalNode {
	src: string;
	altText: string;
	width: number | null;
	height: number | null;
	maxWidth: number;
	caption: string;
	showCaption: boolean;
	isFullWidth: boolean;
	cropX: number;
	cropY: number;
	cropScale: number;
	alignment: 'left' | 'center' | 'right';
}

export class ImageNode extends DecoratorNode<null> {
	__src: string;
	__altText: string;
	__width: number | null;
	__height: number | null;
	__maxWidth: number;
	__caption: string;
	__showCaption: boolean;
	__isFullWidth: boolean;
	__cropX: number;
	__cropY: number;
	__cropScale: number;
	__alignment: 'left' | 'center' | 'right';

	static getType(): string {
		return 'image';
	}

	static clone(node: ImageNode): ImageNode {
		return new ImageNode(
			node.__src,
			node.__altText,
			node.__width,
			node.__height,
			node.__maxWidth,
			node.__caption,
			node.__showCaption,
			node.__isFullWidth,
			node.__cropX,
			node.__cropY,
			node.__cropScale,
			node.__alignment,
			node.__key,
		);
	}

	constructor(
		src: string,
		altText: string,
		width: number | null,
		height: number | null,
		maxWidth: number,
		caption: string,
		showCaption: boolean,
		isFullWidth: boolean,
		cropX: number,
		cropY: number,
		cropScale: number,
		alignment: 'left' | 'center' | 'right',
		key?: NodeKey,
	) {
		super(key);
		this.__src = src;
		this.__altText = altText;
		this.__width = width;
		this.__height = height;
		this.__maxWidth = maxWidth;
		this.__caption = caption;
		this.__showCaption = showCaption;
		this.__isFullWidth = isFullWidth;
		this.__cropX = cropX;
		this.__cropY = cropY;
		this.__cropScale = cropScale;
		this.__alignment = alignment;
	}

	isInline(): boolean {
		return false;
	}

	isKeyboardSelectable(): boolean {
		return true;
	}

	decorate(): null {
		return null;
	}

	// Getters
	getSrc(): string {
		return this.getLatest().__src;
	}
	getAltText(): string {
		return this.getLatest().__altText;
	}
	getWidth(): number | null {
		return this.getLatest().__width;
	}
	getHeight(): number | null {
		return this.getLatest().__height;
	}
	getMaxWidth(): number {
		return this.getLatest().__maxWidth;
	}
	getCaption(): string {
		return this.getLatest().__caption;
	}
	getShowCaption(): boolean {
		return this.getLatest().__showCaption;
	}
	getIsFullWidth(): boolean {
		return this.getLatest().__isFullWidth;
	}
	getCropX(): number {
		return this.getLatest().__cropX;
	}
	getCropY(): number {
		return this.getLatest().__cropY;
	}
	getCropScale(): number {
		return this.getLatest().__cropScale;
	}
	getAlignment(): 'left' | 'center' | 'right' {
		return this.getLatest().__alignment;
	}

	// Setters
	setSrc(src: string): this {
		const self = this.getWritable();
		self.__src = src;
		return self;
	}
	setAltText(altText: string): this {
		const self = this.getWritable();
		self.__altText = altText;
		return self;
	}
	setWidthAndHeight(width: number | null, height: number | null): this {
		const self = this.getWritable();
		self.__width = width;
		self.__height = height;
		return self;
	}
	setMaxWidth(maxWidth: number): this {
		const self = this.getWritable();
		self.__maxWidth = maxWidth;
		return self;
	}
	setCaption(caption: string): this {
		const self = this.getWritable();
		self.__caption = caption;
		return self;
	}
	setShowCaption(showCaption: boolean): this {
		const self = this.getWritable();
		self.__showCaption = showCaption;
		return self;
	}
	setFullWidth(isFullWidth: boolean): this {
		const self = this.getWritable();
		self.__isFullWidth = isFullWidth;
		return self;
	}
	setCrop(cropX: number, cropY: number, cropScale: number): this {
		const self = this.getWritable();
		self.__cropX = cropX;
		self.__cropY = cropY;
		self.__cropScale = cropScale;
		return self;
	}
	setAlignment(alignment: 'left' | 'center' | 'right'): this {
		const self = this.getWritable();
		self.__alignment = alignment;
		return self;
	}

	exportJSON(): SerializedImageNode {
		return {
			...super.exportJSON(),
			src: this.__src,
			altText: this.__altText,
			width: this.__width,
			height: this.__height,
			maxWidth: this.__maxWidth,
			caption: this.__caption,
			showCaption: this.__showCaption,
			isFullWidth: this.__isFullWidth,
			cropX: this.__cropX,
			cropY: this.__cropY,
			cropScale: this.__cropScale,
			alignment: this.__alignment,
		};
	}

	static importJSON(serializedNode: SerializedImageNode): ImageNode {
		return $createImageNode({
			src: serializedNode.src,
			altText: serializedNode.altText,
		}).updateFromJSON(serializedNode);
	}

	updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedImageNode>): this {
		return super
			.updateFromJSON(serializedNode)
			.setSrc(serializedNode.src)
			.setAltText(serializedNode.altText)
			.setWidthAndHeight(serializedNode.width, serializedNode.height)
			.setMaxWidth(serializedNode.maxWidth)
			.setCaption(serializedNode.caption)
			.setShowCaption(serializedNode.showCaption)
			.setFullWidth(serializedNode.isFullWidth)
			.setCrop(
				Number.isFinite(serializedNode.cropX) ? serializedNode.cropX : 0,
				Number.isFinite(serializedNode.cropY) ? serializedNode.cropY : 0,
				Number.isFinite(serializedNode.cropScale) ? serializedNode.cropScale : 1,
			)
			.setAlignment(serializedNode.alignment === 'left' || serializedNode.alignment === 'right' ? serializedNode.alignment : 'center');
	}
}

export function $createImageNode({
	src,
	altText,
	width,
	height,
	maxWidth = 700,
	caption = '',
	showCaption = false,
	isFullWidth = false,
	cropX = 0,
	cropY = 0,
	cropScale = 1,
	alignment = 'center',
	key,
}: ImagePayload): ImageNode {
	return $applyNodeReplacement(
		new ImageNode(
			src,
			altText,
			width ?? null,
			height ?? null,
			maxWidth,
			caption,
			showCaption,
			isFullWidth,
			cropX,
			cropY,
			cropScale,
			alignment,
			key,
		),
	);
}

export function $isImageNode(node: LexicalNode | null | undefined): node is ImageNode {
	return node instanceof ImageNode;
}
