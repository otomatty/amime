import { segmentGraphemes } from "@amime/editor-core";
import {
	type InlineNode,
	type LineKind,
	type ParsedLine,
	parseLine,
	type Span,
	type TableCell,
} from "@amime/parser";
import { type CSSProperties, Fragment, memo, type ReactNode } from "react";
import { pageHref, projectHref } from "./links.ts";

type EditorLineProps = {
	/** ページ内での行番号(0始まり)。 */
	readonly index: number;
	/** ページの中でのこの行の役割(classifyLines の結果)。 */
	readonly kind: LineKind;
	/** この行が属するブロックの、始まりの行のインデント。 */
	readonly blockIndent: number;
	/** 行頭の空白を含む、行の生のテキスト。 */
	readonly text: string;
	/** この行を編集中のときの、カーソルの文字位置。編集中でなければ null。 */
	readonly caretColumn: number | null;
	/** 日本語入力などで変換中の文字列。変換中でなければ null。 */
	readonly composing: string | null;
	/** この行の中で選択されている範囲(文字位置)。選択にかかっていなければ null。 */
	readonly selectionStart?: number | null;
	readonly selectionEnd?: number | null;
	/** 選択がこの行の改行を越えて、次の行へ続いているか。 */
	readonly selectsLineBreak?: boolean;
	/** この行にいる、他の人のカーソル(ADR-0023)。 */
	readonly others?: readonly RemoteCaret[] | undefined;
};

/** 他の人のカーソル。 */
export type RemoteCaret = {
	/** 人(端末)を区別する値。 */
	readonly key: string;
	/** 行の本文の中の位置。相手の画面での位置なので、この行の本文より後ろを指していることがある。 */
	readonly column: number;
	/** 人ごとの色の番号。 */
	readonly color: number;
};

const NO_OTHERS: readonly RemoteCaret[] = [];

/** 太字の段階(* の数)として見た目に反映する上限。 */
const MAX_DECORATION_LEVEL = 10;

type NodeOf<Type extends InlineNode["type"]> = Extract<InlineNode, { readonly type: Type }>;
/** 中に他の記法を書けるノード。 */
type ContainerNode = Extract<InlineNode, { readonly children: readonly InlineNode[] }>;
/** 記法の記号と、表示する中身とに分かれるノード。 */
type ContentNode = Extract<InlineNode, { readonly content: Span }>;

type RenderContext = {
	/** 行の生のテキスト。 */
	readonly text: string;
	readonly caretColumn: number | null;
	/** カーソル(と、変換中の文字列)の要素。 */
	readonly caret: ReactNode;
	/** この行を編集中か。編集中は記法の記号も見せ、リンクや画像を実体にしない。 */
	readonly editing: boolean;
	/** この行の中で選択されている範囲。選択にかかっていなければ null。 */
	readonly selection: Span | null;
	/** 選択が次の行へ続いていることを示す、行末の印。続いていなければ null。 */
	readonly lineBreak: ReactNode;
	/** この行にいる、他の人のカーソル。 */
	readonly others: readonly RemoteCaret[];
};

/**
 * start 以上 end 未満の位置にいる、他の人のカーソルの要素。
 * 行の本文のどの位置も、描画するどれか1つの要素の範囲に入るようにしてあるので、カーソルは必ず1度だけ描画される。
 * 文字の途中や、隠している記法の中を指す位置は、その要素の前に寄せる。
 */
function othersIn(ctx: RenderContext, start: number, end: number): ReactNode {
	if (ctx.others.length === 0) return null;
	return ctx.others
		.filter(({ column }) => column >= start && column < end)
		.map(({ key, color }) => (
			<span
				className="remote-caret"
				data-testid="remote-caret"
				data-color={color}
				aria-hidden="true"
				key={`other-${key}`}
			/>
		));
}

/** span の全体が選択されていれば、クラス名に選択の印を足す。 */
function marked(ctx: RenderContext, span: Span, className: string): string {
	const { selection } = ctx;
	const selected = selection !== null && span.start >= selection.start && span.end <= selection.end;
	return selected ? `${className} selected` : className;
}

/** 画面に並べる1文字ぶんの要素。位置は、行の生のテキストでの位置。 */
type Piece = { readonly text: string; readonly start: number; readonly end: number };

/**
 * span の範囲を、利用者から見た1文字ずつに分ける。
 *
 * 行全体ではなく範囲ごとに分けるので、記法の境界をまたいで結合する文字
 * (「]」の直後の結合文字など)も境界で切れる。記号を隠しても、範囲の中の文字は必ず表示される。
 * 分けた位置は、行全体で見た文字の境界をすべて含む。そのため、カーソルを置ける位置には
 * 必ず要素の先頭がある。
 */
function pieces(ctx: RenderContext, span: Span): Piece[] {
	return segmentGraphemes(ctx.text.slice(span.start, span.end)).map((grapheme) => ({
		text: grapheme.text,
		start: span.start + grapheme.column,
		end: span.start + grapheme.column + grapheme.text.length,
	}));
}

/**
 * span の範囲にある文字を、1文字ずつの要素にする。
 * 各要素が生のテキストでの位置を持つので、押された要素からカーソル位置を求められる。
 */
function chars(ctx: RenderContext, span: Span, className = "char"): ReactNode[] {
	return pieces(ctx, span).map((piece) => (
		<Fragment key={piece.start}>
			{othersIn(ctx, piece.start, piece.end)}
			{piece.start === ctx.caretColumn && ctx.caret}
			<span
				className={marked(ctx, piece, className)}
				data-column={piece.start}
				data-end={piece.end}
			>
				{piece.text}
			</span>
		</Fragment>
	));
}

/** 行頭の空白。文字としては見せず、1段ぶんの幅を持つ要素にする。bullet なら最後の1つに箇条書きの印を付ける。 */
function indents(ctx: RenderContext, indent: number, bullet: boolean): ReactNode[] {
	return pieces(ctx, { start: 0, end: indent }).map((piece) => (
		<Fragment key={piece.start}>
			{othersIn(ctx, piece.start, piece.end)}
			{piece.start === ctx.caretColumn && ctx.caret}
			<span
				className={marked(ctx, piece, "indent")}
				data-bullet={bullet && piece.end === indent ? "" : undefined}
				data-column={piece.start}
				data-end={piece.end}
			/>
		</Fragment>
	));
}

/** 記法の記号。編集中の行でだけ見せる。隠しているときも、その中にいる他の人のカーソルは描画する。 */
function notation(ctx: RenderContext, span: Span): ReactNode {
	return ctx.editing ? chars(ctx, span, "char notation") : othersIn(ctx, span.start, span.end);
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
			className={marked(ctx, node, "image")}
			src={node.src}
			alt={node.link ?? ""}
			loading="lazy"
			// 画像の置き場所に、見ているページのURLを伝えない。
			referrerPolicy="no-referrer"
			{...atomPosition(node)}
		/>
	);
	return (
		<>
			{othersIn(ctx, node.start, node.end)}
			{node.link === null ? element : link(ctx, { href: node.link, external: true }, element)}
		</>
	);
}

function icon(ctx: RenderContext, node: NodeOf<"icon">): ReactNode {
	if (ctx.editing) return chars(ctx, node);
	return (
		<>
			{othersIn(ctx, node.start, node.end)}
			<span className={marked(ctx, node, "icon")} title={node.name} {...atomPosition(node)}>
				{node.name}
				{node.count > 1 && `×${node.count}`}
			</span>
		</>
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

/**
 * テーブルのセル。
 * セルの区切りのタブは描画しない。代わりに、セルの残りの幅を埋める要素(cell-fill)に
 * セルの末尾の位置を持たせる。行の余白を押したとき(hit-test の columnOnRow)に、
 * 空のセルも位置の候補になる。セルの中の余白を押したときは、data-cell-start / data-cell-end を使って
 * そのセルの中で位置を決める。
 */
function tableCell(ctx: RenderContext, cell: TableCell): ReactNode {
	const { content } = cell;
	const last = content.end === ctx.text.length;
	return (
		<span
			className="cell"
			key={content.start}
			data-cell-start={content.start}
			data-cell-end={content.end}
		>
			<span className="cell-box">
				<span className="cell-text">
					{renderNodes(ctx, cell.nodes)}
					{/* セルの末尾(区切りのタブの位置)。最後のセルでは、行の本文より後ろの位置も引き受ける。 */}
					{othersIn(ctx, content.end, last ? Number.POSITIVE_INFINITY : content.end + 1)}
					{ctx.caretColumn === content.end && ctx.caret}
					{/* テーブルの行では、行末の印を最後のセルの中に置く(行の直下に置くと列が1つ増えてしまう)。 */}
					{content.end === ctx.text.length && ctx.lineBreak}
				</span>
				<span className="cell-fill" data-column={content.end} data-end={content.end} />
			</span>
		</span>
	);
}

/** インデントより後ろの、行の中身。 */
function lineBody(ctx: RenderContext, parsed: ParsedLine): ReactNode {
	switch (parsed.kind) {
		case "title":
		case "text":
			return renderNodes(ctx, parsed.nodes);
		case "code-head":
		case "table-head":
			return (
				<span className="block-label">
					{notation(ctx, parsed.prefix)}
					{chars(ctx, parsed.name)}
				</span>
			);
		case "code-body":
			return <span className="code-text">{chars(ctx, parsed.content)}</span>;
		case "table-row":
			return parsed.cells.map((cell) => tableCell(ctx, cell));
	}
}

/**
 * 1行を描画する。
 * 編集中の行(カーソルのある行)は、記法の記号も含めて生のテキストをそのまま見せる。
 * それ以外の行は記号を隠し、リンクや装飾として見せる(ADR-0012)。
 * コードブロックとテーブルの行は、役割に応じた形で描画する(ADR-0013)。
 */
export const EditorLine = memo(function EditorLine({
	index,
	text,
	kind,
	blockIndent,
	caretColumn,
	composing,
	selectionStart = null,
	selectionEnd = null,
	selectsLineBreak = false,
	others = NO_OTHERS,
}: EditorLineProps) {
	const parsed = parseLine(text, { kind, blockIndent });
	const style = { "--indent": parsed.indent } as CSSProperties;

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
	const selection =
		selectionStart === null || selectionEnd === null
			? null
			: { start: selectionStart, end: selectionEnd };
	// 選択が次の行へ続いていることを、行末の印で示す(空行でも選択されていると分かる)。
	const lineBreak = selectsLineBreak ? <span className="line-break selected" /> : null;
	const ctx: RenderContext = {
		text,
		caretColumn,
		caret,
		editing: caretColumn !== null,
		selection,
		lineBreak,
		others,
	};
	const isRow = parsed.kind === "table-row";
	// コードとテーブルの行は箇条書きではないので、印を付けない。
	const indentSpans = indents(ctx, parsed.indent, !isRow && parsed.kind !== "code-body");

	return (
		<div
			className="line"
			data-testid="line"
			data-line={index}
			data-kind={parsed.kind}
			data-indent={parsed.indent}
			data-text={text}
			style={style}
		>
			{isRow ? <span className="cell indent-cell">{indentSpans}</span> : indentSpans}
			{lineBody(ctx, parsed)}
			{/* テーブルの行では、行末のカーソルは最後のセルが描画する。 */}
			{!isRow && othersIn(ctx, text.length, Number.POSITIVE_INFINITY)}
			{!isRow && caretColumn === text.length && caret}
			{!isRow && lineBreak}
		</div>
	);
});
