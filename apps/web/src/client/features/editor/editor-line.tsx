import { type Grapheme, segmentGraphemes } from "@amime/editor-core";
import { type InlineNode, type ParsedLine, parseIndent, parseLine, type Span } from "@amime/parser";
import { type CSSProperties, Fragment, memo, type ReactNode } from "react";
import { pageHref, projectHref } from "./links.ts";

type EditorLineProps = {
	/** ページ内での行番号(0始まり)。0 はタイトル行。 */
	readonly index: number;
	/** 行頭の空白を含む、行の生のテキスト。 */
	readonly text: string;
	/** この行を編集中のときの、カーソルの文字位置。編集中でなければ null。 */
	readonly caretColumn: number | null;
	/** 日本語入力などで変換中の文字列。変換中でなければ null。 */
	readonly composing: string | null;
};

/** 太字の段階(* の数)として見た目に反映する上限。 */
const MAX_DECORATION_LEVEL = 10;

type NodeOf<Type extends InlineNode["type"]> = Extract<InlineNode, { readonly type: Type }>;
/** 中に他の記法を書けるノード。 */
type ContainerNode = Extract<InlineNode, { readonly children: readonly InlineNode[] }>;
/** 記法の記号と、表示する中身とに分かれるノード。 */
type ContentNode = Extract<InlineNode, { readonly content: Span }>;

type RenderContext = {
	readonly graphemes: readonly Grapheme[];
	readonly caretColumn: number | null;
	/** カーソル(と、変換中の文字列)の要素。 */
	readonly caret: ReactNode;
	/** この行を編集中か。編集中は記法の記号も見せ、リンクや画像を実体にしない。 */
	readonly editing: boolean;
};

/** 開始位置が column 以上である最初の文字の番号。graphemes は位置の昇順なので、二分探索で求める。 */
function firstIndexFrom(graphemes: readonly Grapheme[], column: number): number {
	let low = 0;
	let high = graphemes.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((graphemes[middle]?.column ?? column) < column) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** 開始位置が span の中にある文字。記法が多い長い行でも、行の長さに比例する手間で済ませる。 */
function graphemesIn(ctx: RenderContext, span: Span): readonly Grapheme[] {
	return ctx.graphemes.slice(
		firstIndexFrom(ctx.graphemes, span.start),
		firstIndexFrom(ctx.graphemes, span.end),
	);
}

/**
 * span の範囲にある文字を、1文字ずつの要素にする。
 * 各要素が生のテキストでの位置を持つので、押された要素からカーソル位置を求められる。
 */
function chars(ctx: RenderContext, span: Span, className = "char"): ReactNode[] {
	return graphemesIn(ctx, span).map((grapheme) => (
		<Fragment key={grapheme.column}>
			{grapheme.column === ctx.caretColumn && ctx.caret}
			<span
				className={className}
				data-column={grapheme.column}
				data-end={grapheme.column + grapheme.text.length}
			>
				{grapheme.text}
			</span>
		</Fragment>
	));
}

/** 行頭の空白。文字としては見せず、1段ぶんの幅を持つ要素にする。 */
function indents(ctx: RenderContext, indent: number): ReactNode[] {
	return graphemesIn(ctx, { start: 0, end: indent }).map((grapheme) => (
		<Fragment key={grapheme.column}>
			{grapheme.column === ctx.caretColumn && ctx.caret}
			<span
				className="indent"
				data-bullet={grapheme.column === indent - 1 ? "" : undefined}
				data-column={grapheme.column}
				data-end={grapheme.column + grapheme.text.length}
			/>
		</Fragment>
	));
}

/** 記法の記号。編集中の行でだけ見せる。 */
function notation(ctx: RenderContext, span: Span): ReactNode {
	return ctx.editing ? chars(ctx, span, "char notation") : null;
}

/** 中身(inner)の前後に、そのノードの記法の記号を並べる。 */
function withNotation(ctx: RenderContext, node: ContentNode, inner: ReactNode): ReactNode {
	return (
		<>
			{notation(ctx, { start: node.start, end: node.content.start })}
			{inner}
			{notation(ctx, { start: node.content.end, end: node.end })}
		</>
	);
}

type LinkTarget = { readonly href: string; readonly external: boolean };

/**
 * リンク。編集中の行では実体のリンクにしない
 * (押したときに移動せず、その位置にカーソルを置けるようにするため)。
 */
function link(ctx: RenderContext, target: LinkTarget, body: ReactNode): ReactNode {
	if (ctx.editing) return <span className="link">{body}</span>;
	if (!target.external) {
		return (
			<a className="link" href={target.href}>
				{body}
			</a>
		);
	}
	return (
		<a className="link" href={target.href} target="_blank" rel="noopener noreferrer">
			{body}
		</a>
	);
}

function linkTarget(node: ContentNode): LinkTarget | null {
	switch (node.type) {
		case "page-link":
		case "hashtag":
			return { href: pageHref(node.title), external: false };
		case "project-link":
			return { href: projectHref(node.project, node.title), external: false };
		case "external-link":
			return { href: node.url, external: true };
		default:
			return null;
	}
}

/** 画像やアイコンのように、1つの要素で記法全体を表すものが持つ位置。 */
const atomPosition = (node: Span) => ({ "data-column": node.start, "data-end": node.end });

function image(ctx: RenderContext, node: NodeOf<"image">): ReactNode {
	if (ctx.editing) return <span className="link">{chars(ctx, node)}</span>;
	const element = (
		// 画像の内容は分からない。リンク付きならリンク先を代替テキストにし、なければ空にする。
		<img
			className="image"
			src={node.src}
			alt={node.link ?? ""}
			loading="lazy"
			// 画像の置き場所に、見ているページのURLを伝えない。
			referrerPolicy="no-referrer"
			{...atomPosition(node)}
		/>
	);
	return node.link === null ? element : link(ctx, { href: node.link, external: true }, element);
}

function icon(ctx: RenderContext, node: NodeOf<"icon">): ReactNode {
	if (ctx.editing) return chars(ctx, node);
	return (
		<span className="icon" title={node.name} {...atomPosition(node)}>
			{node.name}
			{node.count > 1 && `×${node.count}`}
		</span>
	);
}

/** 中に他の記法を書けるノード。子を描画し、前後に記法の記号を並べる。 */
function container(ctx: RenderContext, node: ContainerNode): ReactNode {
	const body = withNotation(ctx, node, renderNodes(ctx, node.children));
	switch (node.type) {
		case "strong":
			return <strong>{body}</strong>;
		case "quote":
			return <span className="quote">{body}</span>;
		case "decoration": {
			const level = Math.min(node.level, MAX_DECORATION_LEVEL);
			const style = { "--deco-level": level } as CSSProperties;
			return (
				<span className="deco" data-deco={node.marks} style={style}>
					{body}
				</span>
			);
		}
	}
}

function renderNode(ctx: RenderContext, node: InlineNode): ReactNode {
	if (node.type === "text") return chars(ctx, node);
	if (node.type === "image") return image(ctx, node);
	if (node.type === "icon") return icon(ctx, node);
	if ("children" in node) return container(ctx, node);

	const body = withNotation(ctx, node, chars(ctx, node.content));
	const target = linkTarget(node);
	if (target !== null) return link(ctx, target, body);
	return <code className={node.type}>{body}</code>;
}

function renderNodes(ctx: RenderContext, nodes: readonly InlineNode[]): ReactNode[] {
	return nodes.map((node) => <Fragment key={node.start}>{renderNode(ctx, node)}</Fragment>);
}

/** タイトル行は記法を解釈しない。インデント以降の全体を、ただの文字列として扱う。 */
function parseTitle(text: string): ParsedLine {
	const { indent } = parseIndent(text);
	return { indent, nodes: [{ type: "text", start: indent, end: text.length }] };
}

/**
 * 1行を描画する。
 * 編集中の行(カーソルのある行)は、記法の記号も含めて生のテキストをそのまま見せる。
 * それ以外の行は記号を隠し、リンクや装飾として見せる(ADR-0012)。
 */
export const EditorLine = memo(function EditorLine({
	index,
	text,
	caretColumn,
	composing,
}: EditorLineProps) {
	const isTitle = index === 0;
	const { indent, nodes } = isTitle ? parseTitle(text) : parseLine(text);
	const style = { "--indent": indent } as CSSProperties;

	const caret = (
		<>
			{composing && (
				<span className="composing" data-testid="composing">
					{composing}
				</span>
			)}
			<span className="caret" data-testid="caret" />
		</>
	);
	const ctx: RenderContext = {
		graphemes: segmentGraphemes(text),
		caretColumn,
		caret,
		editing: caretColumn !== null,
	};

	return (
		<div
			className={isTitle ? "line title" : "line"}
			data-testid="line"
			data-line={index}
			data-indent={indent}
			data-text={text}
			style={style}
		>
			{indents(ctx, indent)}
			{renderNodes(ctx, nodes)}
			{caretColumn === text.length && caret}
		</div>
	);
});
