import {
	type InlineNode,
	inlineNodes,
	type LineRole,
	parseLine,
	writePageLink,
} from "@tsuzuri/parser";
import { toTitleLc } from "@tsuzuri/shared";
import { ceilToBoundary } from "./graphemes.ts";
import { lineAtCursor } from "./state.ts";
import type { EditorState } from "./types.ts";

/** 書いている途中のリンク。 */
export type LinkQuery = {
	/** 括弧のリンク([名前])か、タグ(#名前)か。 */
	readonly kind: "bracket" | "hashtag";
	/** 名前の始まり(記号の次)。行の中の位置。 */
	readonly start: number;
	/** 名前の終わり。補完するときは、start からここまでを置き換える。 */
	readonly end: number;
	/** 閉じる括弧が、もうあるか。タグは、いつも true(閉じる記号がない)。 */
	readonly closed: boolean;
	/** カーソルまでに入力した、名前の一部。 */
	readonly query: string;
};

type LinkNode = Extract<InlineNode, { readonly type: "page-link" | "hashtag" }>;

// 既定は、ふつうの行。記法の読み方は、表やコードなどの行の役割でだけ変わる。
// Stryker disable next-line ObjectLiteral,StringLiteral: 上のとおり、ふつうの行と同じに読む指定では、結果は変わらない
const TEXT_LINE: LineRole = { kind: "text", blockIndent: 0 };

/**
 * 行を記法として読んで、名前の途中か終わりにカーソルがある、ページへのリンクを探す。
 * どこがリンクかは、表示と同じ解析に任せる(コード、数式、コマンドの行、テーブルのセルの区切りなどを、同じように扱う)。
 */
function linkAt(text: string, column: number, role: LineRole): LinkNode | null {
	const inside = (node: InlineNode): node is LinkNode =>
		(node.type === "page-link" && node.content.start < column && column <= node.content.end) ||
		(node.type === "hashtag" && node.start + 1 < column && column <= node.end);
	return inlineNodes(parseLine(text, role)).find(inside) ?? null;
}

/**
 * カーソルが、ページへのリンクでもタグでもない記法(アイコン、外部リンク、数式、コードなど)の中にあるか。
 * 中に他の記法を書ける記法(装飾、強調、引用)は、数えない。
 */
function insideOtherNotation(text: string, column: number, role: LineRole): boolean {
	return inlineNodes(parseLine(text, role)).some(
		(node) =>
			node.type !== "text" &&
			// 括弧のリンクの中にカーソルがあるときは、ここで数えても数えなくても、同じ結果になる
			// (書けているリンクとして扱うか、名前の前なので対象にしない)。読み手のために書く。
			// Stryker disable next-line ConditionalExpression,StringLiteral: 上のとおり、結果は変わらない
			node.type !== "page-link" &&
			node.type !== "hashtag" &&
			!("children" in node) &&
			node.start < column &&
			column < node.end,
	);
}

/**
 * 行の中のカーソルの位置で、ページへのリンクを書いている途中なら、その範囲と、入力した名前の一部を返す。
 * 括弧のリンク([名前)と、タグ(#名前)を対象にする。装飾や外部リンクなど、他の記法は対象にしない。
 * role は、ページの中でのその行の役割。コードブロックの中などの、リンクを書けない行では null。
 */
export function linkQueryAt(
	text: string,
	column: number,
	role: LineRole = TEXT_LINE,
): LinkQuery | null {
	// もう書けているリンク(閉じた括弧か、タグ)の中にいるか。
	const written = linkAt(text, column, role);
	// 閉じていない括弧は、カーソルの位置で閉じたものとして読む。そこで閉じて、ページへのリンクになるなら、書いている途中。
	// もう書けている別の記法(アイコン、外部リンクなど)の中では、そう読まない(閉じると、その記法を壊してしまう)。
	const closing = `${text.slice(0, column)}]${text.slice(column)}`;
	const tryClosing = written?.type !== "page-link" && !insideOtherNotation(text, column, role);
	const unclosed = tryClosing ? linkAt(closing, column, role) : null;
	// 閉じたものとして読んで見つかるのは、カーソルのところで閉じたリンクだけ(後ろで閉じるリンクなら、written になっている)。
	const bracket = unclosed?.type === "page-link" && unclosed.content.end === column;
	const node = bracket ? unclosed : written;
	if (node === null) return null;
	if (node.type === "hashtag") {
		const start = node.start + 1;
		return {
			kind: "hashtag",
			start,
			end: node.end,
			closed: true,
			query: text.slice(start, column),
		};
	}
	const query = text.slice(node.content.start, column);
	// 空白から始まる名前と、[[強調]] の内側の括弧は、対象にしない。
	if (/^\s/.test(query) || text.charAt(node.start - 1) === "[") return null;
	return {
		kind: "bracket",
		start: node.content.start,
		end: bracket ? column : node.content.end,
		closed: !bracket,
		query,
	};
}

/**
 * 書いている途中のリンク(行 text の link)を、title へのリンクにした行と、リンクの後ろの位置。
 * title へのリンクとして書けない名前(括弧を含む、URLやアイコンとして読まれる、など)なら null。
 * 補完した行を記法として読み直して、その位置が title へのリンクとして読まれることも確かめる
 * (名前の中の記号が、行の中の他の記号と組になって、別の記法になることがある)。
 */
function completed(
	text: string,
	link: LinkQuery,
	title: string,
	role: LineRole,
): { readonly text: string; readonly column: number } | null {
	// writePageLink は、"hashtag" かどうかだけを見る。
	const written = writePageLink(title, link.kind === "bracket" ? "page-link" : "hashtag");
	if (written === null) return null;
	// 記号([ か #)から、名前の終わりまでを置き換える。閉じる括弧がもうあれば、それも含める。
	const from = link.start - 1;
	const to = link.kind === "bracket" && link.closed ? link.end + 1 : link.end;
	const line = text.slice(0, from) + written + text.slice(to);
	const end = from + written.length;
	const linked = inlineNodes(parseLine(line, role)).some(
		(node) =>
			(node.type === "page-link" || node.type === "hashtag") &&
			// 始まり、終わり、名前の確かめは、互いに重なっている(どれか1つを省いても、ほかの2つで同じ判定になる)。
			// 補完した文字が、別の記法と組になったときに備えて、すべて書く。
			// Stryker disable next-line ConditionalExpression: 上のとおり、結果は変わらない
			node.start === from &&
			// Stryker disable next-line ConditionalExpression: 上のとおり、結果は変わらない
			node.end === end &&
			// Stryker disable next-line ConditionalExpression: 上のとおり、結果は変わらない
			toTitleLc(node.title) === toTitleLc(title),
	);
	return linked ? { text: line, column: end } : null;
}

/**
 * 行 text の、書いている途中のリンクを、title へのリンクとして補完できるか。
 * 書いても別のものとして読まれる名前は、補完できない。
 */
export function canCompleteLink(
	text: string,
	link: LinkQuery,
	title: string,
	role: LineRole = TEXT_LINE,
): boolean {
	return completed(text, link, title, role) !== null;
}

/**
 * 書いている途中のリンク(カーソルのある行の link)を、title へのリンクにする。
 * 括弧のリンクは、閉じる括弧がなければ足す。タグは、タグとして書けない名前なら [名前] にする。
 * カーソルは、リンクの後ろに置く。title へのリンクとして書けない名前なら、何も変えない。
 */
export function completeLink(
	state: EditorState,
	link: LinkQuery,
	title: string,
	role: LineRole = TEXT_LINE,
): EditorState {
	const result = completed(lineAtCursor(state), link, title, role);
	if (result === null) return state;
	const { line } = state.cursor;
	return {
		lines: state.lines.toSpliced(line, 1, result.text),
		// 補完した文字が後ろの文字と結合することがある。その場合は、結合した文字の後ろに置く。
		cursor: { line, column: ceilToBoundary(result.text, result.column) },
	};
}
