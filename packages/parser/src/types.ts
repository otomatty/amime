/** 行の生のテキストの中の範囲。位置は UTF-16 の単位で数え、end はその位置を含まない。 */
export type Span = {
	readonly start: number;
	readonly end: number;
};

/**
 * 記法の解析結果。どのノードも、行の生のテキストの中で自分が占める範囲(start〜end)を持つ。
 * content は、記法の記号を除いた「表示する中身」の範囲。
 * start〜content.start と content.end〜end が記法の記号にあたる。
 */
export type InlineNode =
	| TextNode
	| CodeNode
	| FormulaNode
	| PageLinkNode
	| HashtagNode
	| ProjectLinkNode
	| ExternalLinkNode
	| ImageNode
	| IconNode
	| DecorationNode
	| StrongNode
	| QuoteNode;

/** 記法ではない、ただの文字列。 */
type TextNode = Span & { readonly type: "text" };

/** `コード` */
type CodeNode = Span & { readonly type: "code"; readonly content: Span };

/** [$ 数式] */
type FormulaNode = Span & { readonly type: "formula"; readonly content: Span };

/** [ページタイトル] */
type PageLinkNode = Span & {
	readonly type: "page-link";
	readonly content: Span;
	readonly title: string;
};

/** #タグ。content は # を含む。 */
type HashtagNode = Span & {
	readonly type: "hashtag";
	readonly content: Span;
	readonly title: string;
};

/** [/プロジェクト/ページタイトル] または [/プロジェクト] */
type ProjectLinkNode = Span & {
	readonly type: "project-link";
	readonly content: Span;
	readonly project: string;
	readonly title: string | null;
};

/** https://… / [URL] / [URL 表示文字] / [表示文字 URL]。content は表示する文字列(なければURL)。 */
type ExternalLinkNode = Span & {
	readonly type: "external-link";
	readonly content: Span;
	readonly url: string;
};

/** [画像URL] / [画像URL リンク先URL] / [リンク先URL 画像URL] */
export type ImageNode = Span & {
	readonly type: "image";
	readonly src: string;
	readonly link: string | null;
};

/** [名前.icon] / [名前.icon*3] */
type IconNode = Span & {
	readonly type: "icon";
	readonly name: string;
	readonly count: number;
};

/** [* 太字] [/ 斜体] [- 打ち消し] [_ 下線] など。marks は使われた記号(重複なし)。 */
type DecorationNode = Span & {
	readonly type: "decoration";
	readonly content: Span;
	readonly children: readonly InlineNode[];
	readonly marks: string;
	/** * の数。0 なら太字ではない。数が多いほど大きく表示する。 */
	readonly level: number;
};

/** [[強調]] */
type StrongNode = Span & {
	readonly type: "strong";
	readonly content: Span;
	readonly children: readonly InlineNode[];
};

/** > 引用。行頭(インデントの直後)にだけ現れる。 */
type QuoteNode = Span & {
	readonly type: "quote";
	readonly content: Span;
	readonly children: readonly InlineNode[];
};

export type ParsedLine = {
	/** インデントの深さ。 */
	readonly indent: number;
	/** インデントより後ろを、隙間も重なりもなく覆うノードの列。 */
	readonly nodes: readonly InlineNode[];
};
