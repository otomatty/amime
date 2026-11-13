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

/** リンクの名前を区切る文字(空白、括弧、バッククォート)。 */
const DELIMITER = /[\s[\]`]/;
/** [記号 文字](装飾)と [$ 式](数式)の先頭。ページへのリンクではない。 */
const NOTATION_HEAD = /^[!"#%&'()*+,\-./{|}<>_~$]+ /;

/** position より前にある、閉じていないコード(`…)の中か。 */
const insideCode = (text: string, position: number): boolean =>
	text.slice(0, position).split("`").length % 2 === 0;

/** position から前へ、条件に合う文字が続くかぎり戻る。戻った先の位置を返す。 */
function scanBack(text: string, position: number, within: (character: string) => boolean): number {
	let start = position;
	while (start > 0 && within(text.charAt(start - 1))) start -= 1;
	return start;
}

/** open の位置で開いた括弧の中を、ページへのリンクとして書いている途中か。 */
function bracketQuery(text: string, open: number, column: number): LinkQuery | null {
	const query = text.slice(open + 1, column);
	const otherNotation =
		// [[強調]] の内側の括弧。
		text.charAt(open - 1) === "[" ||
		// 装飾、数式、外部リンク、他のプロジェクトへのリンク。
		NOTATION_HEAD.test(query) ||
		query.includes("://") ||
		query.startsWith("/");
	if (query === "" || /^\s/.test(query) || otherNotation || insideCode(text, open)) return null;
	// カーソルより後ろで、最初に出てくる括弧。閉じる括弧なら、そこまでがリンクの名前。
	const next = text.slice(column).search(/[[\]]/);
	const closed = next !== -1 && text.charAt(column + next) === "]";
	return { kind: "bracket", start: open + 1, end: closed ? column + next : column, closed, query };
}

/** カーソルが、タグ(#名前)を書いている途中か。 */
function hashtagQuery(text: string, column: number): LinkQuery | null {
	const start = scanBack(text, column, (character) => !DELIMITER.test(character));
	// 文中の # は、直前が空白のときだけタグの始まり(「C#」などを巻き込まない)。括弧やコードの直後も、タグにならない。
	const begins = text.charAt(start) === "#" && (start === 0 || /\s/.test(text.charAt(start - 1)));
	const query = text.slice(start + 1, column);
	if (!begins || query === "" || insideCode(text, start)) return null;
	const rest = text.slice(column).search(DELIMITER);
	const end = rest === -1 ? text.length : column + rest;
	return { kind: "hashtag", start: start + 1, end, closed: true, query };
}

/**
 * 行の中のカーソルの位置で、ページへのリンクを書いている途中なら、その範囲と、入力した名前の一部を返す。
 * 括弧のリンク([名前)と、タグ(#名前)を対象にする。装飾や外部リンクなど、他の記法は対象にしない。
 * 行がコードブロックの中かどうかは、呼ぶ側で確かめる。
 */
export function linkQueryAt(text: string, column: number): LinkQuery | null {
	// カーソルより前の、いちばん近い括弧。開く括弧なら、その中にいる。
	const bracket = scanBack(text, column, (character) => character !== "[" && character !== "]");
	if (text.charAt(bracket - 1) === "[") return bracketQuery(text, bracket - 1, column);
	return hashtagQuery(text, column);
}

/**
 * 書いている途中のリンク(カーソルのある行の link)を、title へのリンクにする。
 * 括弧のリンクは、閉じる括弧がなければ足す。タグは、タグとして書けない名前なら [名前] にする。
 * カーソルは、リンクの後ろに置く。
 */
export function completeLink(state: EditorState, link: LinkQuery, title: string): EditorState {
	const text = lineAtCursor(state);
	const tag = title.replaceAll(" ", "_");
	// 置き換える範囲の始まりと、そこに入れる文字列。
	const [from, written] =
		link.kind === "bracket"
			? [link.start, `${title}]`]
			: DELIMITER.test(tag)
				? [link.start - 1, `[${title}]`]
				: [link.start, tag];
	// 閉じる括弧がもうあれば、それも置き換える範囲に含める(足した括弧と重ねない)。
	const to = link.kind === "bracket" && link.closed ? link.end + 1 : link.end;
	const completed = text.slice(0, from) + written + text.slice(to);
	const { line } = state.cursor;
	return {
		lines: state.lines.toSpliced(line, 1, completed),
		// 補完した文字が後ろの文字と結合することがある。その場合は、結合した文字の後ろに置く。
		cursor: { line, column: ceilToBoundary(completed, from + written.length) },
	};
}
